# Amigo Secreto · Lista de deseos

App web (Angular 19) donde cada persona del amigo secreto escribe lo que le gustaría recibir y todos ven las listas de todos. Se entra con un enlace, sin cuentas ni contraseñas. Los datos se guardan en Supabase (plan gratis).

## Cómo funciona

- Cada persona se registra con **nombre + DNI**. El DNI no se muestra a nadie; solo evita registros duplicados o a nombre de otro.
- El navegador queda recordado: solo esa persona puede editar o borrar sus deseos. Ese dispositivo ya no muestra el formulario de registro.
- Si cambia de celular o borra el navegador, entra con **"Ya me registré"** y su DNI.
- Por IP hay un límite de **5 registros** para frenar abusos. No es 1 porque una oficina o un WiFi de casa comparten la misma IP. Se cambia en `sf_max_per_ip()` del SQL.
- El tablero se actualiza solo cada 20 segundos y al volver a la pestaña.

## 1. Configurar Supabase (una sola vez)

1. Crea un proyecto gratis en https://supabase.com.
2. Ve a **SQL Editor → New query**, pega todo `supabase/schema.sql` y dale **Run**.
3. Ve a **Project Settings → API** y copia en `src/app/config.ts`:
   - **Project URL** en `supabaseUrl`.
   - La clave **anon public** en `supabaseAnonKey`.

   La anon key es pública por diseño. Las tablas están cerradas y todo pasa por funciones que validan, así que con esa clave no se puede leer el DNI ni editar lo de otro.
4. Opcional: cambia `eventName` / `eventSubtitle` en el mismo archivo.

## 2. Desarrollo

```bash
npm install
npx ng serve
```

Abre http://localhost:4200.

## 3. Publicar

```bash
npx ng build
```

Sube el contenido de `dist/secret-friend/browser/` a cualquier hosting estático: Netlify (arrastrar la carpeta), Vercel, Cloudflare Pages, GitHub Pages o un sitio en IIS. Comparte esa URL con el grupo.

## Reiniciar para otro año

En Supabase → SQL Editor:

```sql
truncate public.wishes, public.participants;
```
