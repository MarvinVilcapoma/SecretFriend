import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { APP_CONFIG, isConfigured } from './config';
import { ApiError, Participant, Session, Wish, WishlistApiService } from './wishlist-api.service';

const SESSION_KEY = 'secret-friend.session';
const THEME_KEY = 'secret-friend.theme';
const REFRESH_MS = 20_000;

/** Colores de avatar (se elige por el id, así cada persona conserva el suyo). */
const AVATAR_COLORS = ['#b91c1c', '#15803d', '#b45309', '#0e7490', '#7c3aed', '#be185d', '#4d7c0f', '#1d4ed8'];

interface WishDraft {
  title: string;
  price_hint: string;
  link: string;
  note: string;
}

const emptyDraft = (): WishDraft => ({ title: '', price_hint: '', link: '', note: '' });

/** Piezas del estallido al agregar un deseo o registrarse. */
const BURST_EMOJI = ['❄️', '⭐', '🎁', '🎄', '✨', '🔔'];
const BURST_COLORS = ['#ef4444', '#facc15', '#22c55e', '#38bdf8', '#ffffff'];

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

@Component({
  selector: 'app-root',
  imports: [FormsModule, NgTemplateOutlet],
  templateUrl: './app.component.html',
})
export class AppComponent implements OnInit, OnDestroy {
  private api = inject(WishlistApiService);

  readonly config = APP_CONFIG;
  readonly configured = isConfigured();

  readonly board = signal<Participant[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly session = signal<Session | null>(this.readSession());

  // Registro / entrada
  readonly joinMode = signal<'new' | 'back'>('new');
  joinName = '';
  joinDni = '';
  readonly joinError = signal<string | null>(null);
  readonly joining = signal(false);

  // Formulario de deseo
  draft: WishDraft = emptyDraft();
  readonly editingId = signal<string | null>(null);
  readonly saving = signal(false);
  readonly wishError = signal<string | null>(null);
  readonly showMore = signal(false);

  readonly query = signal('');
  readonly toast = signal<string | null>(null);

  /** Tema: index.html ya puso la clase "dark" antes de pintar (sin parpadeo). */
  readonly dark = signal(document.documentElement.classList.contains('dark'));

  // Decoración navideña de la cabecera (valores fijos al cargar).
  readonly snowflakes = Array.from({ length: 42 }, (_, i) => ({
    glyph: i % 6 === 0,
    left: rand(0, 100),
    size: rand(3, 7),
    drift: rand(-40, 40),
    opacity: rand(.45, .95),
    duration: rand(7, 15),
    delay: -rand(0, 15), // negativo: ya está nevando al abrir la página
  }));
  readonly lights = Array.from({ length: 36 });

  readonly me = computed(() => {
    const s = this.session();
    return s ? this.board().find(p => p.id === s.id) ?? null : null;
  });

  readonly totalWishes = computed(() => this.board().reduce((n, p) => n + p.wishes.length, 0));

  readonly others = computed(() => {
    const myId = this.session()?.id;
    const q = this.normalize(this.query());
    return this.board()
      .filter(p => p.id !== myId)
      .filter(p => !q
        || this.normalize(p.name).includes(q)
        || p.wishes.some(w => this.normalize(w.title).includes(q)));
  });

  private timer?: ReturnType<typeof setInterval>;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private onVisible = () => { if (document.visibilityState === 'visible') this.load(true); };

  ngOnInit(): void {
    if (!this.configured) {
      this.loading.set(false);
      return;
    }
    this.load();
    this.timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !this.saving()) this.load(true);
    }, REFRESH_MS);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
    clearTimeout(this.toastTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  async load(silent = false): Promise<void> {
    if (!silent) this.loading.set(true);
    try {
      const data = await this.api.getBoard();
      this.board.set(data);
      this.loadError.set(null);
      // Si mi registro ya no existe (lo borraron), suelto la sesión local.
      const s = this.session();
      if (s && !data.some(p => p.id === s.id)) this.setSession(null);
    } catch (e) {
      if (!silent) this.loadError.set(this.message(e));
    } finally {
      this.loading.set(false);
    }
  }

  // ---------- Registro ----------

  async join(origin?: Element | null): Promise<void> {
    if (this.joining()) return;
    const dni = this.joinDni.replace(/\D/g, '');
    const isNew = this.joinMode() === 'new';

    if (isNew && this.joinName.trim().length < 2) return this.joinError.set('Escribe tu nombre (mínimo 2 letras).');
    if (dni.length !== 8) return this.joinError.set('El DNI debe tener 8 dígitos.');

    this.joining.set(true);
    this.joinError.set(null);
    try {
      const s = isNew
        ? await this.api.register(this.joinName, dni)
        : await this.api.recover(dni);
      this.celebrate(origin);
      this.setSession(s);
      this.joinName = '';
      this.joinDni = '';
      this.showToast(isNew ? `¡Listo, ${s.name}! Agrega tu primer deseo.` : `Hola de nuevo, ${s.name}.`);
      await this.load(true);
    } catch (e) {
      this.joinError.set(this.message(e));
    } finally {
      this.joining.set(false);
    }
  }

  setJoinMode(mode: 'new' | 'back'): void {
    this.joinMode.set(mode);
    this.joinError.set(null);
  }

  onDniInput(value: string): void {
    this.joinDni = value.replace(/\D/g, '').slice(0, 8);
  }

  leaveDevice(): void {
    if (!confirm('¿Salir en este dispositivo? Podrás volver a entrar con tu DNI.')) return;
    this.setSession(null);
    this.cancelEdit();
  }

  // ---------- Deseos ----------

  async saveWish(origin?: Element | null): Promise<void> {
    const s = this.session();
    if (!s || this.saving()) return;
    if (!this.draft.title.trim()) return this.wishError.set('Escribe qué te gustaría recibir.');

    this.saving.set(true);
    this.wishError.set(null);
    try {
      const id = this.editingId();
      if (id) await this.api.updateWish(s.token, id, this.draft);
      else await this.api.addWish(s.token, this.draft);
      if (!id) this.celebrate(origin);
      this.showToast(id ? 'Deseo actualizado' : 'Deseo agregado');
      this.cancelEdit();
      await this.load(true);
    } catch (e) {
      this.handleAuthError(e);
      this.wishError.set(this.message(e));
    } finally {
      this.saving.set(false);
    }
  }

  editWish(w: Wish): void {
    this.editingId.set(w.id);
    this.draft = {
      title: w.title,
      price_hint: w.price_hint ?? '',
      link: w.link ?? '',
      note: w.note ?? '',
    };
    this.showMore.set(!!(w.link || w.note || w.price_hint));
    this.wishError.set(null);
    document.getElementById('wish-title')?.focus();
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.draft = emptyDraft();
    this.showMore.set(false);
    this.wishError.set(null);
  }

  async removeWish(w: Wish): Promise<void> {
    const s = this.session();
    if (!s || !confirm(`¿Borrar "${w.title}"?`)) return;
    // Optimista: lo quito ya y recargo.
    this.board.update(list => list.map(p => p.id === s.id ? { ...p, wishes: p.wishes.filter(x => x.id !== w.id) } : p));
    if (this.editingId() === w.id) this.cancelEdit();
    try {
      await this.api.deleteWish(s.token, w.id);
      this.showToast('Deseo borrado');
    } catch (e) {
      this.handleAuthError(e);
      this.showToast(this.message(e));
    }
    await this.load(true);
  }

  // ---------- Compartir ----------

  async share(): Promise<void> {
    const url = location.origin + location.pathname;
    const data = { title: this.config.eventName, text: 'Agrega tu lista de deseos del amigo secreto 🎁', url };
    if (navigator.share) {
      try { await navigator.share(data); return; } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      this.showToast('Enlace copiado');
    } catch {
      prompt('Copia este enlace:', url);
    }
  }

  // ---------- Celebración ----------

  /** Estallido de copos, estrellas y regalos desde el botón que se pulsó. */
  private celebrate(origin?: Element | null): void {
    if (prefersReducedMotion()) return;
    const r = origin?.getBoundingClientRect();
    const x = r ? r.left + r.width / 2 : innerWidth / 2;
    const y = r ? r.top + r.height / 2 : innerHeight / 2;

    for (let i = 0; i < 28; i++) {
      const el = document.createElement('span');
      const isEmoji = i % 2 === 0;
      el.className = isEmoji ? 'burst' : 'burst burst-dot';
      if (isEmoji) el.textContent = BURST_EMOJI[i % BURST_EMOJI.length];
      else el.style.background = BURST_COLORS[i % BURST_COLORS.length];

      const angle = rand(0, Math.PI * 2);
      const dist = rand(70, 170);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.setProperty('--x', `${Math.cos(angle) * dist}px`);
      el.style.setProperty('--y', `${Math.sin(angle) * dist - 50}px`); // un poco hacia arriba
      el.style.setProperty('--r', `${rand(-260, 260)}deg`);
      el.style.animationDelay = `${rand(0, 80)}ms`;
      el.addEventListener('animationend', () => el.remove(), { once: true });
      document.body.append(el);
    }
  }

  // ---------- Tema ----------

  toggleTheme(): void {
    const dark = !this.dark();
    this.dark.set(dark);
    document.documentElement.classList.toggle('dark', dark);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#06170d' : '#14532d');
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch { /* modo privado */ }
  }

  // ---------- Helpers de vista ----------

  initials(name: string): string {
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  avatarColor(id: string): string {
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  linkHost(link: string): string {
    try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return 'Ver enlace'; }
  }

  // ---------- Privados ----------

  private handleAuthError(e: unknown): void {
    if (e instanceof ApiError && e.code === 'SESSION_INVALID') {
      this.setSession(null);
      this.setJoinMode('back');
    }
  }

  private message(e: unknown): string {
    return e instanceof ApiError ? e.message : 'Algo salió mal. Inténtalo otra vez.';
  }

  private showToast(msg: string): void {
    this.toast.set(msg);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), 2600);
  }

  private normalize(s: string): string {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  }

  private readSession(): Session | null {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      const s = raw ? JSON.parse(raw) : null;
      return s?.id && s?.token ? s : null;
    } catch {
      return null;
    }
  }

  private setSession(s: Session | null): void {
    this.session.set(s);
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch { /* modo privado: la sesión dura solo esta pestaña */ }
  }
}
