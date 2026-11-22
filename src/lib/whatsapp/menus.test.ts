import { describe, expect, it } from 'vitest'
import { INTERACTIVE_LIMITS } from './meta-api'
import {
  BOT_MENUS,
  isMenuReplyId,
  menuMessage,
  menuOfRowId,
  menuSentNote,
  mentionsMenus,
  takeMenuMarker,
} from './menus'

const len = (s: string) => [...s].length

describe('takeMenuMarker', () => {
  it('finds the menu and removes the marker from the text', () => {
    expect(takeMenuMarker('أهلاً بك. [[MENU:services]]')).toEqual({ menu: 'services', text: 'أهلاً بك. ' })
    expect(takeMenuMarker('[[ menu : SERVICES ]]').menu).toBe('services')
  })

  it('ignores a menu that does not exist, but still never lets the marker through', () => {
    expect(takeMenuMarker('Hi [[MENU:prices]]')).toEqual({ menu: null, text: 'Hi ' })
    expect(takeMenuMarker('Hi there')).toEqual({ menu: null, text: 'Hi there' })
  })

  it.each(['constructor', '__proto__', 'tostring', 'hasownproperty'])(
    'does not take %s for a menu',
    (name) => {
      expect(takeMenuMarker(`Hi [[MENU:${name}]]`)).toEqual({ menu: null, text: 'Hi ' })
    },
  )

  it.each(['[MENU:services]', '[[MENU: our services]]', '[[MENU:our-services]]'])(
    'strips a mangled marker (%s) without sending a menu for it',
    (mangled) => {
      expect(takeMenuMarker(`Hello. ${mangled}`)).toEqual({ menu: null, text: 'Hello. ' })
    },
  )

  it("strips the history's own note if the model echoes it, without sending a menu for it", () => {
    expect(menuSentNote('services')).toBe('[menu sent: services]')
    expect(takeMenuMarker(`Hello. ${menuSentNote('services')}`)).toEqual({ menu: null, text: 'Hello. ' })
    expect(takeMenuMarker('Hello. [menu sent]')).toEqual({ menu: null, text: 'Hello. ' })
  })

  it('leaves ordinary brackets and a form marker alone', () => {
    expect(takeMenuMarker('Sizes [S, M, L] and a menu to pick from').text).toBe(
      'Sizes [S, M, L] and a menu to pick from',
    )
    expect(takeMenuMarker('Tap below. [[FORM:furniture_moving]]')).toEqual({
      menu: null,
      text: 'Tap below. [[FORM:furniture_moving]]',
    })
  })
})

describe('mentionsMenus', () => {
  it('is how an account switches menus on', () => {
    expect(mentionsMenus('When a customer only greets you, add [[MENU:services]] after your reply.')).toBe(true)
    expect(mentionsMenus('[[ menu : services ]]')).toBe(true)
    expect(mentionsMenus('We are a cleaning company. See the menu on our website.')).toBe(false)
    expect(mentionsMenus('For moving add [[FORM:furniture_moving]].')).toBe(false)
    expect(mentionsMenus(null)).toBe(false)
    expect(mentionsMenus(undefined)).toBe(false)
  })
})

describe('menuOfRowId / isMenuReplyId', () => {
  it("knows a tap on the bot's own menu from every other tap, and which menu it was", () => {
    expect(menuOfRowId('menu:services:villas')).toBe('services')
    expect(menuOfRowId('menu:offers:ramadan_2027')).toBe('offers')
    expect(isMenuReplyId('menu:services:villas')).toBe(true)
  })

  it.each(['yes', 'csat_5', 'services', 'plan_menu:basic', 'menu:', 'menu:services', 'menu::x', 'menu:Bad Name:x', 'MENU:services:x', '', null, undefined])(
    'does not take %s for a menu row',
    (other) => {
      expect(menuOfRowId(other)).toBeNull()
      expect(isMenuReplyId(other)).toBe(false)
    },
  )
})

// The owner's list, in his order. Only "Steam cleaning (sofas, carpets)"
// was shortened, to fit Meta's 24 characters. This is the ONE place the
// wording is pinned: every other test reads it from `menuMessage`.
const TITLES = {
  en: [
    'AC cleaning',
    'Kitchen and bathrooms',
    'Apartments and floors',
    'Villas',
    'Floor polishing',
    'Steam (sofas, carpets)',
    'Pest control',
    'Water tanks',
    'Swimming pools',
    'Furniture moving',
  ],
  ar: [
    'تنظيف مكيفات',
    'مطبخ ودورات مياه',
    'شقق وأدوار',
    'فلل',
    'جلي وتلميع',
    'تنظيف كنب وسجاد بالبخار',
    'مكافحة حشرات',
    'تنظيف خزانات',
    'تنظيف مسابح',
    'نقل عفش',
  ],
}

describe.each(['ar', 'en'] as const)("menuMessage('services', '%s')", (lang) => {
  const message = menuMessage('services', lang)
  const rows = message.sections.flatMap((s) => s.rows)

  it('lists the ten services in order, under one button', () => {
    expect(message.buttonLabel).toBe(lang === 'ar' ? 'الخدمات' : 'Services')
    expect(message.sections).toHaveLength(1)
    expect(message.sections[0].title).toBe(lang === 'ar' ? 'خدماتنا' : 'Our services')
    expect(rows.map((r) => r.title)).toEqual(TITLES[lang])
  })

  it("gives every row an id of this menu's, the same in both languages", () => {
    expect(rows.map((r) => r.id)).toEqual(BOT_MENUS.services.rows.map((r) => `menu:services:${r.id}`))
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
    expect(rows.every((r) => menuOfRowId(r.id) === 'services')).toBe(true)
    // Just id and title: no descriptions.
    expect(rows.every((r) => Object.keys(r).sort().join() === 'id,title')).toBe(true)
  })

  it("stays inside Meta's limits for a list message", () => {
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThanOrEqual(INTERACTIVE_LIMITS.maxListRowsTotal)
    expect(message.sections.length).toBeLessThanOrEqual(INTERACTIVE_LIMITS.maxListSections)
    expect(len(message.buttonLabel)).toBeLessThanOrEqual(INTERACTIVE_LIMITS.buttonTitleMaxLength)
    // Meta caps a section title like a row title: 24 characters.
    expect(len(message.sections[0].title)).toBeLessThanOrEqual(INTERACTIVE_LIMITS.listRowTitleMaxLength)
    for (const r of rows) {
      // `.length` is what the sender itself checks; code points is what Meta most likely counts.
      expect(r.title.length, r.title).toBeLessThanOrEqual(INTERACTIVE_LIMITS.listRowTitleMaxLength)
      expect(len(r.title), r.title).toBeLessThanOrEqual(INTERACTIVE_LIMITS.listRowTitleMaxLength)
      expect(r.title.trim(), r.id).not.toBe('')
      expect(r.id.length).toBeLessThanOrEqual(200)
    }
  })
})
