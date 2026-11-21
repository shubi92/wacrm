# Forms the AI agent sends

The AI agent can send a form instead of asking typed questions. The
customer gets one short line with an **Open form** button, fills in a page
of ours, and taps Send. The agent then thanks them and hands the chat to a
person with every answer attached.

The form is a web page in this app (`/form/<token>`), opened by a WhatsApp
link button. It is not a Meta "WhatsApp Flow", and it has nothing to do
with the **Flows** menu in this app, which is the automation builder.

## Forms in this repo

| Form               | Definition                                   | Page                         |
| ------------------ | -------------------------------------------- | ---------------------------- |
| `furniture_moving` | `src/lib/whatsapp/forms/furniture-moving.ts` | `src/app/form/[token]/`      |

The definition is the single source: the page draws its four steps from
it, the server checks the answers against it, and the same file turns the
answers into the lines the sales rep reads. The page is Arabic,
right to left, with an English switch; it opens in the language of the
agent's line. Branding (logo, colours, the WhatsApp number behind "Back to
WhatsApp") is a set of constants beside the definition, because only one
business uses forms today.

## One-time setup

1. Run migration `041_form_links.sql` (one table and one function).
2. Make sure `NEXT_PUBLIC_SITE_URL` is set to the site's public `https://`
   address. The agent builds the form's link from it. Without it the agent
   cannot send the form and hands the chat to a person instead.
3. Tell the AI agent when to send the form, in **AI Agents → Business
   context & instructions**. For example:

   > When a customer wants furniture moving, do not ask questions and do
   > not mention any price. Reply with one short line inviting them to
   > fill in the form, and add `[[FORM:furniture_moving]]` after your reply.
   > If they write instead of opening the form, hand off.

Naming a form in the instructions (`[[FORM:…]]`) is what switches forms on
for the account. Without it the agent is never told forms exist and never
sends one.

## What happens

1. Customer asks about moving → the agent sends its one line with an
   **Open form** button. This uses one of the agent's replies for the chat.
   The button opens the page in the phone's default web browser (that is
   what Meta documents for a link button).
2. Customer fills the four steps and taps Send, and sees a "received"
   screen with a summary and a **Back to WhatsApp** button.
3. The answers appear in the inbox as one message, in this order: name,
   move, from, to, date, furniture, not in the list, appliances, kitchen
   cabinets, pack kitchenware, air conditioners, curtains, call time, notes.
4. The agent sends a short thank-you in the chat (no price) and hands the
   chat over. Connected systems get `conversation.handed_off` with
   `reason: "customer_ready"` and the answers in `lead.details`
   (see [public-api.md](../public-api.md)).

If the agent is switched off, paused on that chat, or a person already has
the chat when the form comes back, the answers still appear in the inbox
but nothing else happens: no thank-you and no `conversation.handed_off`.
That includes a customer who typed after getting the form, was handed
off, and filled the form in later.

If the form cannot be sent, the agent hands the chat to a person and the
inbox note says why.

## The link

- The address holds only a random token: no phone number, name or chat id.
  The server looks up which chat it belongs to. Only a hash of the token is
  stored, and the link is not kept in the inbox message.
- It works for 7 days and for one submission. Opened again after sending,
  it shows the "received" screen, until the 7 days are up. An unknown,
  altered or expired link shows
  a plain "this link is no longer valid, please message us on WhatsApp".
- Sending is a public endpoint (`POST /api/forms/<token>`), so the server
  trusts nothing from the browser: every choice must be one of the form's
  options, every count a whole number from 0 to 20, every text 300
  characters or fewer, the date not in the past. The body is capped at
  16 KB and sends are rate-limited per link and per IP address.

## Menus

The agent can also put a tap-to-choose menu under one of its lines: a
WhatsApp list message, one button that opens a list of up to ten
options. Menus are defined in `src/lib/whatsapp/menus.ts`, each with a
name, in Arabic and English (chosen by the language of the agent's
line). Today there is one, `services`.

Switch it on the same way as a form, by naming it in the agent's
instructions. For example:

> If the customer only greets you, greet back in ONE short line and add
> `[[MENU:services]]` after your reply. Do not list our services yourself.

- The option the customer taps comes back as an ordinary message whose
  text is the option's title (for example "نقل عفش"), so the rest of the
  instructions apply to it as if it had been typed.
- Each menu goes out once per chat. After that, or if WhatsApp refuses
  the list, the agent's line is sent as plain text. Nobody is handed off
  because a menu could not be sent.
- Connected systems get the tap as a normal `message.received` with
  `interactive_reply_id` set to `menu:services:<option>`.

## Limits worth knowing

- The thank-you is an ordinary WhatsApp message, so Meta only delivers it
  inside the 24-hour window after the customer's last message. A customer
  who sends the form days later still sees the "received" screen, and the
  chat is still handed over.
- A form submission is not a WhatsApp message: it does not fire
  `message.received`, a Flow, or a keyword automation.
- If the agent sends the form twice in one chat, both links work until one
  is used or they expire.
- Answers are not saved on the phone while the customer is filling the
  form in. Closing the page before sending loses them.
