# Customer Hub pending versus history — 2026-11-15

The page previously used totalConversations as the Messages tab's urgent badge,
so 27 historical conversations could look like 27 unanswered cases. The page
heading also combined mail and claims into a generic attention total.

The main title and mail summary now say «Ждут ответа: N». The Messages tab badge
uses unreadMessages (mail awaiting count), never totalConversations. The history
caption explicitly says «История за 30 дней: 27 (не требуют ответа)» when the
fresh snapshot has no awaiting conversations. With awaiting items the caption
instead says it includes all statuses. Stale data says unknown/last saved data,
never a fabricated zero or a no-response-required assertion.

Needs review is separate, with one line explaining older mail without matched
reply evidence and the need for manual review; it is not a confirmed pending
queue. The history filter is labelled «История», not an unqualified total.
Russian copy here follows the owner's explicit wording for this task.

Validation: actual MailInboxPanel component integration passes with zero and
one awaiting cases, history caption, filters, message bodies, Process next and
refresh success/failure. Changed-file lint, TypeScript and production build are
required. No source classification, buyer sends, Seller Central or VPS browser
operations are changed. Production counts are verified through the mail API;
visual browser automation remains unavailable in this session.
