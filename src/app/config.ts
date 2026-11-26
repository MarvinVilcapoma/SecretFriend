/**
 * Configuración de la app.
 *
 * supabaseUrl / supabaseAnonKey: Supabase → Project Settings → API.
 * La anon key es pública por diseño (va en el navegador); la seguridad
 * la dan las funciones de supabase/schema.sql, no esta clave.
 */
export const APP_CONFIG = {
  supabaseUrl: 'https://ijedevjeuzqsaqxwbowr.supabase.co',
  supabaseAnonKey: 'sb_publishable_9lnaVXXzovtI0o24B1HMpw_2-WMBiwh',

  eventName: 'Amigo Secreto',
  eventSubtitle: 'Escribe lo que te gustaría recibir y mira lo que piden los demás.',
};

export const isConfigured = () =>
  // Detecta si aún están los valores de ejemplo. No se edita: solo se cambian supabaseUrl y supabaseAnonKey arriba.
  !APP_CONFIG.supabaseUrl.includes('TU-PROYECTO') && !APP_CONFIG.supabaseAnonKey.startsWith('TU-');
