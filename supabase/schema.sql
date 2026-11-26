-- =====================================================================
-- Amigo Secreto · Lista de deseos
-- Ejecutar completo en Supabase → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr para actualizar las funciones.
--
-- Seguridad:
--   * Las tablas tienen RLS activo y SIN políticas: la anon key no puede
--     leerlas ni escribirlas directamente.
--   * Todo pasa por funciones SECURITY DEFINER (RPC) que validan.
--   * El DNI y el token del dispositivo se guardan solo como hash SHA-256;
--     nunca se devuelven al navegador.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- Configuración ----------
-- Máximo de personas que se pueden registrar desde una misma IP.
-- (Una oficina o un WiFi de casa comparten IP, por eso no es 1.)
create or replace function public.sf_max_per_ip() returns int
language sql immutable as $$ select 5 $$;

-- Máximo de deseos por persona.
create or replace function public.sf_max_wishes() returns int
language sql immutable as $$ select 30 $$;

-- ---------- Tablas ----------
create table if not exists public.participants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 2 and 60),
  dni_hash    text not null unique,
  token_hash  text not null,
  ip_hash     text,
  created_at  timestamptz not null default now()
);

create table if not exists public.wishes (
  id              uuid primary key default gen_random_uuid(),
  participant_id  uuid not null references public.participants(id) on delete cascade,
  title           text not null check (char_length(title) between 1 and 120),
  note            text check (note is null or char_length(note) <= 500),
  link            text check (link is null or char_length(link) <= 500),
  price_hint      text check (price_hint is null or char_length(price_hint) <= 40),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_wishes_participant on public.wishes(participant_id);
create index if not exists idx_participants_ip on public.participants(ip_hash);

alter table public.participants enable row level security;
alter table public.wishes       enable row level security;
revoke all on public.participants, public.wishes from anon, authenticated;

-- ---------- Helpers (no expuestos) ----------
create or replace function public.sf_hash(p text) returns text
language sql immutable
set search_path = public, extensions
as $$ select encode(digest('secret-friend:' || p, 'sha256'), 'hex') $$;

-- IP real del cliente, leída del lado del servidor (no la puede falsear el front).
create or replace function public.sf_client_ip() returns text
language sql stable as $$
  select nullif(trim(split_part(
    coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''),
    ',', 1)), '')
$$;

create or replace function public.sf_clean(p text, max_len int) returns text
language sql immutable as $$
  select nullif(left(regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g'), max_len), '')
$$;

create or replace function public.sf_me(p_token text) returns uuid
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare v_id uuid;
begin
  select id into v_id from participants
   where token_hash = sf_hash('token:' || coalesce(p_token, ''));
  if v_id is null then
    raise exception 'SESSION_INVALID';
  end if;
  return v_id;
end $$;

create or replace function public.sf_clean_link(p text) returns text
language plpgsql immutable as $$
declare v text := sf_clean(p, 500);
begin
  if v is null then return null; end if;
  if v !~* '^https?://' then v := 'https://' || v; end if;
  return v;
end $$;

-- ---------- API pública (RPC) ----------

-- Registro: nombre + DNI. Devuelve el token que el navegador guarda.
create or replace function public.register_participant(p_name text, p_dni text)
returns json
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_name  text := sf_clean(p_name, 60);
  v_dni   text := regexp_replace(coalesce(p_dni, ''), '\s', '', 'g');
  v_ip    text := sf_client_ip();
  v_token text := encode(gen_random_bytes(24), 'hex');
  v_id    uuid;
begin
  if v_name is null or char_length(v_name) < 2 then raise exception 'NAME_INVALID'; end if;
  if v_dni !~ '^[0-9]{8}$' then raise exception 'DNI_INVALID'; end if;

  if exists (select 1 from participants where dni_hash = sf_hash('dni:' || v_dni)) then
    raise exception 'DNI_TAKEN';
  end if;

  if v_ip is not null and (
       select count(*) from participants where ip_hash = sf_hash('ip:' || v_ip)
     ) >= sf_max_per_ip() then
    raise exception 'IP_LIMIT';
  end if;

  insert into participants(name, dni_hash, token_hash, ip_hash)
  values (v_name, sf_hash('dni:' || v_dni), sf_hash('token:' || v_token),
          case when v_ip is null then null else sf_hash('ip:' || v_ip) end)
  returning id into v_id;

  return json_build_object('id', v_id, 'name', v_name, 'token', v_token);
end $$;

-- Entrar desde otro dispositivo con el DNI ya registrado.
-- Genera un token nuevo (el dispositivo anterior deja de poder editar).
create or replace function public.recover_participant(p_dni text)
returns json
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_dni   text := regexp_replace(coalesce(p_dni, ''), '\s', '', 'g');
  v_token text := encode(gen_random_bytes(24), 'hex');
  v_row   participants%rowtype;
begin
  if v_dni !~ '^[0-9]{8}$' then raise exception 'DNI_INVALID'; end if;

  update participants set token_hash = sf_hash('token:' || v_token)
   where dni_hash = sf_hash('dni:' || v_dni)
  returning * into v_row;

  if v_row.id is null then raise exception 'DNI_NOT_FOUND'; end if;

  return json_build_object('id', v_row.id, 'name', v_row.name, 'token', v_token);
end $$;

-- Tablero: todas las personas con sus deseos (sin DNI ni tokens).
create or replace function public.get_board()
returns json
language sql stable security definer
set search_path = public, extensions
as $$
  select coalesce(json_agg(p order by p.name), '[]'::json)
  from (
    select pa.id, pa.name, pa.created_at,
           coalesce((
             select json_agg(json_build_object(
                      'id', w.id, 'title', w.title, 'note', w.note,
                      'link', w.link, 'price_hint', w.price_hint,
                      'updated_at', w.updated_at)
                    order by w.created_at)
             from wishes w where w.participant_id = pa.id
           ), '[]'::json) as wishes
    from participants pa
  ) p
$$;

create or replace function public.add_wish(
  p_token text, p_title text, p_note text default null,
  p_link text default null, p_price_hint text default null)
returns uuid
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_me    uuid := sf_me(p_token);
  v_title text := sf_clean(p_title, 120);
  v_id    uuid;
begin
  if v_title is null then raise exception 'TITLE_REQUIRED'; end if;
  if (select count(*) from wishes where participant_id = v_me) >= sf_max_wishes() then
    raise exception 'WISH_LIMIT';
  end if;

  insert into wishes(participant_id, title, note, link, price_hint)
  values (v_me, v_title, sf_clean(p_note, 500), sf_clean_link(p_link), sf_clean(p_price_hint, 40))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.update_wish(
  p_token text, p_id uuid, p_title text, p_note text default null,
  p_link text default null, p_price_hint text default null)
returns void
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_me    uuid := sf_me(p_token);
  v_title text := sf_clean(p_title, 120);
begin
  if v_title is null then raise exception 'TITLE_REQUIRED'; end if;
  update wishes
     set title = v_title, note = sf_clean(p_note, 500),
         link = sf_clean_link(p_link), price_hint = sf_clean(p_price_hint, 40),
         updated_at = now()
   where id = p_id and participant_id = v_me;
  if not found then raise exception 'WISH_NOT_FOUND'; end if;
end $$;

create or replace function public.delete_wish(p_token text, p_id uuid)
returns void
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare v_me uuid := sf_me(p_token);
begin
  delete from wishes where id = p_id and participant_id = v_me;
  if not found then raise exception 'WISH_NOT_FOUND'; end if;
end $$;

create or replace function public.rename_me(p_token text, p_name text)
returns void
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_me   uuid := sf_me(p_token);
  v_name text := sf_clean(p_name, 60);
begin
  if v_name is null or char_length(v_name) < 2 then raise exception 'NAME_INVALID'; end if;
  update participants set name = v_name where id = v_me;
end $$;

-- ---------- Permisos ----------
-- Por defecto Postgres da EXECUTE a PUBLIC: se quita y se abre solo la API.
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.register_participant(text, text)             to anon, authenticated;
grant execute on function public.recover_participant(text)                     to anon, authenticated;
grant execute on function public.get_board()                                   to anon, authenticated;
grant execute on function public.add_wish(text, text, text, text, text)        to anon, authenticated;
grant execute on function public.update_wish(text, uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.delete_wish(text, uuid)                       to anon, authenticated;
grant execute on function public.rename_me(text, text)                         to anon, authenticated;
