import { Injectable } from '@angular/core';
import { APP_CONFIG } from './config';

export interface Wish {
  id: string;
  title: string;
  note: string | null;
  link: string | null;
  price_hint: string | null;
  updated_at: string;
}

export interface Participant {
  id: string;
  name: string;
  created_at: string;
  wishes: Wish[];
}

export interface Session {
  id: string;
  name: string;
  token: string;
}

export interface WishInput {
  title: string;
  note?: string | null;
  link?: string | null;
  price_hint?: string | null;
}

/** Error con el código lanzado por las funciones SQL (DNI_TAKEN, IP_LIMIT…). */
export class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const MESSAGES: Record<string, string> = {
  NAME_INVALID: 'Escribe tu nombre (mínimo 2 letras).',
  DNI_INVALID: 'El DNI debe tener 8 dígitos.',
  DNI_TAKEN: 'Ese DNI ya está registrado. Si eres tú, usa "Ya me registré".',
  DNI_NOT_FOUND: 'No hay nadie registrado con ese DNI.',
  IP_LIMIT: 'Se alcanzó el límite de registros desde esta red.',
  SESSION_INVALID: 'Tu sesión ya no es válida en este dispositivo. Vuelve a entrar con tu DNI.',
  TITLE_REQUIRED: 'Escribe qué te gustaría recibir.',
  WISH_LIMIT: 'Llegaste al máximo de deseos.',
  WISH_NOT_FOUND: 'Ese deseo ya no existe.',
};

@Injectable({ providedIn: 'root' })
export class WishlistApiService {
  getBoard(): Promise<Participant[]> {
    return this.rpc<Participant[]>('get_board', {});
  }

  register(name: string, dni: string): Promise<Session> {
    return this.rpc('register_participant', { p_name: name, p_dni: dni });
  }

  recover(dni: string): Promise<Session> {
    return this.rpc('recover_participant', { p_dni: dni });
  }

  addWish(token: string, w: WishInput): Promise<string> {
    return this.rpc('add_wish', { p_token: token, ...this.wishArgs(w) });
  }

  updateWish(token: string, id: string, w: WishInput): Promise<void> {
    return this.rpc('update_wish', { p_token: token, p_id: id, ...this.wishArgs(w) });
  }

  deleteWish(token: string, id: string): Promise<void> {
    return this.rpc('delete_wish', { p_token: token, p_id: id });
  }

  private wishArgs(w: WishInput) {
    return {
      p_title: w.title,
      p_note: w.note || null,
      p_link: w.link || null,
      p_price_hint: w.price_hint || null,
    };
  }

  private async rpc<T>(fn: string, body: object): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${APP_CONFIG.supabaseUrl}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          apikey: APP_CONFIG.supabaseAnonKey,
          Authorization: `Bearer ${APP_CONFIG.supabaseAnonKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError('NETWORK', 'Sin conexión. Revisa tu internet e inténtalo otra vez.');
    }

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;

    if (!res.ok) {
      const code: string = data?.message ?? 'UNKNOWN';
      throw new ApiError(code, MESSAGES[code] ?? 'Algo salió mal. Inténtalo otra vez.');
    }
    return data as T;
  }
}
