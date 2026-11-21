# WhatsApp forms

A WhatsApp form (Meta calls it a "WhatsApp Flow") opens over the chat, the
customer fills it in, and the answers come back as one message. It has
nothing to do with the **Flows** menu in this app, which is the automation
builder.

The AI agent can send a form instead of asking typed questions. When the
customer sends it back, the agent thanks them and hands the chat to a
person with every answer attached.

## Forms in this repo

| Form               | Files                                                        |
| ------------------ | ------------------------------------------------------------ |
| `furniture_moving` | `furniture_moving_ar.json`, `furniture_moving_en.json`       |

The JSON files are generated from `src/lib/whatsapp/forms/furniture-moving.ts`,
which also reads the answers. Never edit the JSON by hand; change the
definition and run:

```bash
UPDATE_FORMS=1 npx vitest run src/lib/whatsapp/forms
```

## One-time setup for an account

1. In WhatsApp Manager → Account tools → Flows, create a Flow named exactly
   `furniture_moving_ar`. Open its JSON editor, replace everything with the
   contents of `furniture_moving_ar.json`, and save. The editor reports any
   error and shows a preview you can click through.
2. Do the same for `furniture_moving_en` with `furniture_moving_en.json`.
3. Send each draft to your own phone from the builder and check it.
4. Publish both. A form can only be sent to customers once it is published.
5. Tell the AI agent when to send it, in **AI Agents → Business context &
   instructions**. For example:

   > When a customer wants furniture moving, do not ask questions and do
   > not mention any price. Reply with one short line inviting them to
   > fill in the form, and add `[[FORM:furniture_moving]]` after your reply.
   > If they write instead of opening the form, hand off.

The agent sends the Arabic form when its own line is in Arabic and the
English one otherwise. Nothing else needs to be configured in this app:
the form is found by its name, and naming a form in the instructions
(`[[FORM:…]]`) is what switches forms on for the account. Without it the
agent is never told forms exist and never sends one.

## What happens

1. Customer asks about moving → the agent sends its one line with an
   **Open form** button. This uses one of the agent's replies for the chat.
2. Customer fills the four screens and taps Send.
3. The answers appear in the inbox as one message, in this order: customer,
   move, from, to, date, furniture, items not in the list, appliances,
   kitchen cabinets, pack kitchenware, air conditioners, curtains, call
   time, notes.
4. The agent sends a short thank-you (no price) and hands the chat over.
   Connected systems get `conversation.handed_off` with `reason:
   "customer_ready"` and the answers in `lead.details`
   (see [public-api.md](../public-api.md)).

If the agent is switched off, paused on that chat, or a person already has
the chat when the form comes back, the answers still appear in the inbox
but nothing else happens: no thank-you and no `conversation.handed_off`.
That includes a customer who typed after getting the form, was handed
off, and filled the form in later.

A submitted form never starts a Flow or a keyword automation.

If the form cannot be sent (for example no form is published under that
name), the agent hands the chat to a person and the inbox note says why.

## Limits worth knowing

- WhatsApp caps labels at 20 characters on text fields and dropdowns and 30
  on tick lists, so long questions carry a shorter label. WhatsApp adds
  "(optional)" itself to any field that is not required.
- Forms are a single column: the "how many" list for a ticked item appears
  under its group, not beside the item.
- A published form cannot be edited in WhatsApp Manager. A changed form
  means publishing a new one.
- If WhatsApp on a phone does not show and hide the "how many" lists the
  way Meta's preview does, build the fallback (every item has a number list
  starting at 0): `buildMovingFlowJson(lang, 'all')`. The answers are read
  the same way.
