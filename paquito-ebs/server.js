require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const jwt     = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Validar variables obligatorias antes de arrancar
const REQUIRED_ENV = ['TWITCH_EXTENSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n❌ Faltan variables de entorno: ${missing.join(', ')}`);
  console.error('   Copia .env.example → .env y rellena los valores.\n');
  process.exit(1);
}

const EXTENSION_SECRET = Buffer.from(process.env.TWITCH_EXTENSION_SECRET, 'base64');
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app      = express();

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

// ── MIDDLEWARE: verifica JWT de Twitch ────────────────────────────────────────
function verifyTwitchJWT(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }
  const token = authHeader.slice(7);
  try {
    req.twitchPayload = jwt.verify(token, EXTENSION_SECRET, { algorithms: ['HS256'] });
    next();
  } catch (err) {
    console.error('[JWT]', err.message);
    return res.status(403).json({ error: 'Token inválido o expirado' });
  }
}

// Helper: user_id real si compartió identidad, si no opaque_user_id
function getUserId(payload) {
  return payload.user_id || payload.opaque_user_id;
}

// Helper: nombre de Twitch desde el JWT
function getTwitchName(payload) {
  return payload.login || payload.display_name || payload.user_id || payload.opaque_user_id;
}

app.use(express.static('public'));

// ── GET /extension/items ──────────────────────────────────────────────────────
app.get('/extension/items', verifyTwitchJWT, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('shop_items')
      .select('id, name, description, price, icon, image_url, cooldown_ms, effect_type')
      .eq('active', true)
      .eq('category', 'consumable')  // ← añade esto
      .order('price', { ascending: true });

    if (error) throw error;
    return res.json({ items: data || [] });
  } catch (err) {
    console.error('[GET /items]', err.message);
    return res.status(500).json({ error: 'Error al cargar los ítems' });
  }
});

// ── GET /extension/balance ────────────────────────────────────────────────────
app.get('/extension/balance', verifyTwitchJWT, async (req, res) => {
  const userId = getUserId(req.twitchPayload);
  try {
    const { data, error } = await supabase
      .from('runner_users')
      .select('sweat')
      .eq('twitch_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return res.json({ balance: data?.sweat ?? 0 });
  } catch (err) {
    console.error('[GET /balance]', err.message);
    return res.status(500).json({ error: 'Error al obtener el saldo' });
  }
});

// ── POST /extension/use ───────────────────────────────────────────────────────
// Compra y usa un consumible en un solo paso (igual que useItem() en Inventory.vue):
//
//   1. Obtiene el ítem y verifica que esté activo
//   2. Obtiene el usuario y verifica saldo suficiente
//   3. Descuenta sweat de forma atómica (.gte evita race conditions)
//   4. Inserta en consumable_queue  → el juego lo consume
//   5. Inserta en runner_events     → el HUD reacciona en tiempo real
//   6. Registra en shop_use_log     → historial
//
app.post('/extension/use', verifyTwitchJWT, async (req, res) => {
  const userId      = getUserId(req.twitchPayload);
  const twitchName  = getTwitchName(req.twitchPayload);
  const { item_id, injury_id } = req.body;

  if (!item_id) {
    return res.status(400).json({ error: 'Falta item_id' });
  }

  try {
    // ── 1. Obtener ítem ───────────────────────────────────────────────────────
    const { data: item, error: itemErr } = await supabase
      .from('shop_items')
      .select('id, name, icon, price, active, cooldown_ms, effect_type')
      .eq('id', item_id)
      .eq('active', true)
      .single();

    if (itemErr || !item) {
      return res.status(404).json({ error: 'Ítem no encontrado o inactivo' });
    }

    // ── 2. Obtener usuario y saldo ────────────────────────────────────────────
    const { data: user, error: userErr } = await supabase
      .from('runner_users')
      .select('id, twitch_id, twitch_name, sweat')  // ← añade 'id' aquí
      .eq('twitch_id', userId)
      .single();

    if (userErr || !user) {
      return res.status(404).json({ error: 'Usuario no encontrado. ¿Has participado en el chat?' });
    }

    if (user.sweat < item.price) {
      return res.status(402).json({
        error: `Saldo insuficiente (tienes ${user.sweat} 🪙, necesitas ${item.price} 🪙)`,
      });
    }

    // ── 3. Descontar sweat (atómico: .gte evita race conditions) ──────────────
    const { data: updated, error: updateErr } = await supabase
      .from('runner_users')
      .update({ sweat: user.sweat - item.price })
      .eq('twitch_id', userId)
      .gte('sweat', item.price)
      .select('sweat')
      .single();

    if (updateErr || !updated) {
      return res.status(402).json({ error: 'Saldo insuficiente (fallo en comprobación final)' });
    }

    // ── 4 & 5. Efecto según tipo ─────────────────────────────────────────────
    const isHeal = item.effect_type === 'heal_leve' || item.effect_type === 'heal_grave';

    if (isHeal) {
      // Curar la lesión elegida
      if (injury_id) {
        const { error: healErr } = await supabase
          .from('runner_injury')
          .update({ active: false })
          .eq('id', injury_id);
        if (healErr) console.error('[USE] heal injury error:', healErr.message);
      }
      // Notificar al HUD
      await supabase.from('runner_events').insert({
        type: 'heal',
        data: { item_id: item.id, effect_type: item.effect_type, injury_id, twitch_name: user.twitch_name },
      });
    } else {
      // Encolar consumible normal
      const { error: queueErr } = await supabase
        .from('consumable_queue')
        .insert({
          item_id:     item.id,
          user_id:     user.id,
          twitch_name: user.twitch_name,
        });
      if (queueErr) console.error('[USE] consumable_queue error:', queueErr.message);

      // Notificar al HUD
      const eventType = item.effect_type === 'drink' ? 'drink' : item.effect_type ?? 'item';
      const { error: eventErr } = await supabase
        .from('runner_events')
        .insert({
          type: eventType,
          data: { item_id: item.id, effect_type: item.effect_type, twitch_name: user.twitch_name },
        });
      if (eventErr) console.error('[USE] runner_events error:', eventErr.message);
    }

    // ── 6. Log ────────────────────────────────────────────────────────────────
    await supabase.from('shop_use_log').insert({
      twitch_id:  userId,
      item_id:    item.id,
      item_name:  item.name,
      price_paid: item.price,
      used_at:    new Date().toISOString(),
    });

    console.log(`[USE] ${twitchName} → "${item.name}" -${item.price} sweat | saldo=${updated.sweat}`);

    return res.json({
      success:    true,
      balance:    updated.sweat,
      item_name:  item.name,
      price_paid: item.price,
    });

  } catch (err) {
    console.error('[POST /use]', err.message);
    return res.status(500).json({ error: 'Error interno al procesar el uso' });
  }
});

// ── GET /extension/injuries ───────────────────────────────────────────────────
app.get('/extension/injuries', verifyTwitchJWT, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('runner_injury')
      .select('id, zone, severity, speed_penalty')
      .eq('active', true)
    if (error) throw error
    return res.json({ injuries: data || [] })
  } catch (err) {
    console.error('[GET /injuries]', err.message)
    return res.status(500).json({ error: 'Error al cargar las lesiones' })
  }
})

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Paquito EBS escuchando en puerto ${PORT}`);
});
