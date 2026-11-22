// ============================================================
// Menus the AI agent can put under one of its lines: a WhatsApp list
// message — one button that opens a list of options to tap.
//
// Out:  the bot writes `[[MENU:<name>]]` after its reply; its line goes
//       out as the body of a list message (see `auto-reply.ts`).
// Back: a tap arrives as `interactive.list_reply`. Its text is the
//       row's title, and it reaches the agent like a typed message.
//
// A menu is a constant here, like a form (./forms): only one business
// uses them today. ponytail: move to the account when a second does.
// ============================================================

import type { FormLang } from './forms/furniture-moving'

type L = Record<FormLang, string>
const row = (id: string, en: string, ar: string) => ({ id, label: { en, ar } })

interface BotMenu {
  /** Label of the button that opens the list (Meta allows 20 characters). */
  button: L
  /** Heading over the rows (24 characters). */
  title: L
  /** At most 10, each title 24 characters or fewer. */
  rows: { id: string; label: L }[]
}

/** Menus the bot may send. Add one by adding an entry: its name is
 *  what the instructions write in `[[MENU:<name>]]`. */
export const BOT_MENUS: Record<string, BotMenu> = {
  services: {
    button: { en: 'Services', ar: 'الخدمات' },
    title: { en: 'Our services', ar: 'خدماتنا' },
    rows: [
      row('ac_cleaning', 'AC cleaning', 'تنظيف مكيفات'),
      row('kitchen_bathrooms', 'Kitchen and bathrooms', 'مطبخ ودورات مياه'),
      row('apartments_floors', 'Apartments and floors', 'شقق وأدوار'),
      row('villas', 'Villas', 'فلل'),
      row('floor_polishing', 'Floor polishing', 'جلي وتلميع'),
      // "Steam cleaning (sofas, carpets)" is over Meta's 24 characters.
      row('steam_cleaning', 'Steam (sofas, carpets)', 'تنظيف كنب وسجاد بالبخار'),
      row('pest_control', 'Pest control', 'مكافحة حشرات'),
      row('water_tanks', 'Water tanks', 'تنظيف خزانات'),
      row('swimming_pools', 'Swimming pools', 'تنظيف مسابح'),
      row('furniture_moving', 'Furniture moving', 'نقل عفش'),
    ],
  },
}

/** `[[MENU:services]]` in the model's output. */
const MENU_MARKER = /\[\[\s*MENU\s*:\s*([a-z0-9_]+)\s*\]\]/gi
/** Anything shaped like a menu marker, however the model mangled it,
 *  and the history's own `[menu sent]`. */
const MENU_LIKE = /\[{1,2}\s*MENU\b[^\]\n]{0,80}\]{1,2}/gi

/** Appended, in the bot's view of the chat, to a line of its own that
 *  went out with a menu (see `buildConversationContext`). It names the
 *  menu, because each menu may go out once per chat. */
export const menuSentNote = (menu: string) => `[menu sent: ${menu}]`

/** An account switches menus on by naming one in its instructions. */
export const mentionsMenus = (instructions: string | null | undefined): boolean =>
  /\[\[\s*MENU\s*:/i.test(instructions ?? '')

/** The menu the model asked to send (null when none, or one we don't
 *  have), and its text with everything marker-like removed. */
export function takeMenuMarker(text: string): { menu: string | null; text: string } {
  const names = [...text.matchAll(MENU_MARKER)].map((m) => m[1].toLowerCase())
  const menu = names.find((n) => Object.hasOwn(BOT_MENUS, n)) ?? null
  return { menu, text: text.replace(MENU_LIKE, '') }
}

/** A row's id is `menu:<menu>:<row>`: it comes back when the row is
 *  tapped, and is stored with the list the bot sent. */
const ROW_ID = /^menu:([a-z0-9_]+):/

/** The menu a row id belongs to; null for any other id (a Flow's or an
 *  automation's buttons, a template's quick reply). */
export const menuOfRowId = (id: string | null | undefined): string | null =>
  id?.match(ROW_ID)?.[1] ?? null

/** True for a tap on one of the bot's menus. */
export const isMenuReplyId = (id: string | null | undefined): boolean => menuOfRowId(id) !== null

/** What goes to Meta for one menu in one language. */
export function menuMessage(menu: string, lang: FormLang) {
  const m = BOT_MENUS[menu]
  return {
    buttonLabel: m.button[lang],
    sections: [
      {
        title: m.title[lang],
        rows: m.rows.map((r) => ({ id: `menu:${menu}:${r.id}`, title: r.label[lang] })),
      },
    ],
  }
}
