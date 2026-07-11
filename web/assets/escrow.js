// Kaspa Escrow — page module for escrow deals (escrow.html + deal.html).
// Isolated from app.js (pulls only stable low-level helpers), own i18n/DOM/store.
// INVARIANT: the parties' private keys (deal, funding, chat) and media keys NEVER leave
// the browser; only pubkeys, deal parameters, signed transactions, ciphertexts and
// already-encrypted media blobs go to the server. The server never sees plaintext.

// Escrow is a separate product: pull the wasm core DIRECTLY (not via app.js), own boot/net/api.
// Everything is same-origin (kaspaforge.org serves both pages and /api; escrow has no APK/offline).
// v5 = v4 (chat_* Kasia + media_* file encryption) + escrow_mutual_* (split co-signing, Phase 2).
import init, * as core from '/assets/vault-core-v5/kaspa_safe_core.js';
export { core };
import { getDeals, setDeals } from './identity.js';

let network = null;
let kasUsdRate = 0;   // KAS→USD rate (from /api/safe/info), 0 = unavailable → don't show USD
export function net() { return network; }
export function usdStr(sompi) {   // " (≈ $Y)" next to an amount; empty if the rate is unavailable
  if (!(kasUsdRate > 0) || !(sompi > 0)) return '';
  return ' (≈ $' + ((sompi / 1e8) * kasUsdRate).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ')';
}

export async function boot() {
  await init();
  const info = await api('/api/safe/info');
  const n = (info.network || '').toLowerCase();
  network = n.includes('mainnet') ? 'mainnet' : n.includes('testnet') ? 'testnet' : 'simnet';
  kasUsdRate = Number(info.kas_usd) || 0;
  return { ...info, network };
}

export async function api(path, opts) {
  // new URL(…, origin): don't inherit credentials from the address bar (basic-auth bookmarks
  // like https://user:pass@host — relative fetch is forbidden by the browser with those)
  const r = await fetch(new URL(path, location.origin), opts);
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`server: ${r.status}`); }
  if (!r.ok) throw new Error(j.error || `server: ${r.status}`);
  return j;
}

export const kas = (sompi) => (sompi / 1e8).toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' KAS';
export function genToken() {
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
export function fmtBytes(n) {
  if (!(n >= 0)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
export function fmtClock(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const today = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === today.toDateString()) return hm;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`;
}

// ── i18n: language from <html lang> ──
export function lang() { return (document.documentElement.lang || 'en').slice(0, 2); }
const DICT = {
  en: {
    brand: 'Kaspa <b>Escrow</b>',
    role_buyer: "I'm the buyer", role_seller: "I'm the seller",
    noun_buyer: 'buyer', noun_seller: 'seller',
    tpl_goods: 'Physical goods', tpl_otc: 'OTC / crypto trade', tpl_service: 'Service / freelance',
    beta_cap: 'Beta limits: 50 to 10,000 KAS per deal.',
    amount_err: 'Enter an amount between 50 and 10,000 KAS.',
    fee_arb_share: (p) => `Heads up: if this goes to arbitration, the fee is about ${p}% of the amount — arbitration is costly on small deals. It only applies if a dispute reaches a verdict.`,
    creating: 'creating…', gen_invite: 'Generate invite link',
    fee_line: (r, dp) => `Service fee: <b>${r}</b> on release/refund, <b>${dp}</b> if it goes to arbitration.`,
    fee_head: 'Service fee', fee_amicable: 'Release or refund (no dispute)', fee_arb: 'Dispute goes to the arbiter',
    fee_rate_resolve: '0.5% · min 1.2 KAS', fee_rate_dispute: '2% · min 5 KAS',
    fee_enter_amount: 'Enter an amount to see the exact fee.',
    fund_you_pay: 'You fund', fund_seller_gets: 'Seller receives',
    win_pick_hint: 'While the window is open, the buyer can dispute; once it closes, the escrow auto-releases to the seller. The default follows the deal type — pick what fits your deal.',
    invite_ready: 'Deal created. Send this invite link to the other party:',
    save_sheet: 'Download recovery sheet (.txt)',
    ack_sheet: 'I saved the recovery sheet. I understand the private key is my only access to this deal.',
    open_panel: 'Open deal panel →',
    step_done_terms: 'Terms locked', step3_hint: 'The deal panel is your workspace: funding, chat, release / dispute.',
    // join
    deal_title: (n) => `Deal #${n}`,
    invite_title: 'Deal invitation',
    you_are: (r) => `You are the <b>${r}</b> in this deal.`,
    join_btn: 'Generate my key & join', joining: 'joining…',
    join_note: 'Your private key is created in this browser and never leaves it. A recovery sheet (.txt) downloads on join — it is the only copy.',
    join_window: (t) => `Dispute window: ${t} after funding.`,
    addr_mismatch: 'Address mismatch — the deal parameters differ from the server. Do NOT fund. Contact the other party.',
    // panel states
    st_draft: 'draft', st_joined: 'waiting for funding', st_funded: 'funded', st_disputed: 'in dispute', st_closed: 'closed', st_expired: 'expired',
    lbl_status: 'Status', lbl_you_are: 'You are', lbl_amount: 'Amount', lbl_type: 'Type', lbl_addr: 'Escrow address', lbl_conditions: 'Conditions', lbl_window: 'Window',
    fund_head: 'Fund the escrow', fund_hint: 'Send the amount shown below to the funding address — it is YOUR address (key on your recovery sheet). It already includes the service fee, so the seller receives the full deal amount. As soon as it arrives, your browser locks it into the on-chain escrow automatically — keep this page open.',
    fund_addr_lbl: 'Funding address (send here)',
    fund_nokey: 'The funding key is not on this device — fund the deal from the device where it was created or joined.',
    fund_recv: 'Received', fund_send_lbl: 'Amount to send (incl. fee)', fund_wait: 'waiting for transfer…', lock_btn: 'Lock into escrow', locking: 'locking…',
    lock_auto: 'Locks in automatically once the transfer arrives',
    seller_wait: 'Waiting for the buyer to fund the escrow. You will be notified when it is funded.',
    win_left: (t) => `Auto-release to seller in ${t} unless a dispute is opened.`,
    win_over: 'The dispute window is over — auto-release to the seller is imminent.',
    act_buyer: 'You received what you paid for? Release the funds. Something wrong? Open a dispute within the window.',
    release_btn: 'Release funds to seller', dispute_btn: 'Open dispute',
    act_seller: 'Funds are locked in escrow. If you want to cancel and return them to the buyer, use refund.',
    refund_btn: 'Refund the buyer',
    disp_head: 'Dispute open',
    settle_hint: 'You can still settle amicably: the buyer can release, the seller can refund.',
    closed_head: 'Deal closed',
    closed_resolved: 'Funds left the escrow — released to the seller or refunded to the buyer.',
    closed_arbitrated: 'The dispute was resolved — by the arbiter\'s verdict or by the deadline.',
    closed_by: (k) => `Outcome: ${k}.`,
    view_explorer: 'View the escrow address on the explorer →',
    payout_received: 'Returned to you',
    withdraw_after_close: 'Funds are locked in the on-chain covenant. You can withdraw your payout to your own wallet only after the deal closes (release / refund / arbitration).',
    payout_hint: 'These funds are held under your deal key. Withdraw them to any Kaspa address you control.',
    payout_to_lbl: 'Your wallet address',
    payout_withdraw: 'Withdraw funds',
    payout_to_wallet: 'To my desk wallet',
    payout_no_wallet: 'No wallet in this browser profile — open the desk once (or enter an address manually).',
    payout_view: 'View your address on the explorer →',
    payout_need_addr: 'Enter a Kaspa address to withdraw to.',
    payout_bad_addr: 'That does not look like a Kaspa address (must start with kaspa:).',
    payout_no_key: 'Your deal key is missing on this device — open the deal from your recovery sheet to withdraw.',
    payout_confirm: (to) => `Withdraw all funds to\n${to}?`,
    payout_sending: 'Sending…',
    payout_sent: 'Sent ✓ — funds are on the way',
    payout_empty: 'Nothing to withdraw (already withdrawn?).',
    payout_done: '✓ Funds successfully withdrawn',
    payout_done_tx: 'View the withdrawal transaction →',
    confirm_release: 'Release all funds to the seller? This is final.',
    confirm_dispute: 'Open a dispute? Funds freeze until the arbiter rules or the deadline passes.',
    dispute_confirm_note: 'Opening a dispute moves the deal to DISPUTED, brings in the AI mediator, and opens your chat to the arbiter for review. Sign to proceed.',
    dispute_sign_open: 'Sign & open the chat for the arbiter',
    disp_cancel: 'Cancel',
    disp_opened_warn: '⚠️ The buyer opened a dispute. The deal is now in dispute and the AI mediator is involved — state your position below.',
    confirm_refund: 'Refund all funds to the buyer? This is final.',
    tg_btn: 'Connect Telegram', tg_hint: (b, c) => `Send <span class="mono">/start ${c}</span> to <a href="https://t.me/${b}?start=${c}" target="_blank" rel="noopener">@${b}</a>.`,
    no_deal: 'No deal found. Create one or open an invite link.',
    // deal portfolio in this browser (mirrors the safe pattern)
    deals_bar_title: 'My deals', deal_new: '+ New deal',
    deals_done_toggle: (n) => `Completed (${n})`,
    db_rename: 'Name this deal (shown only in this browser):',
    forget_deal: 'Forget this deal in this browser',
    forget_deal_confirm: 'Remove this deal from this browser? Your key goes with it — the recovery sheet (.txt) stays your only way back in.',
    forget_locked: 'Active deal — your key is needed to release/refund or dispute. Removal unlocks once the deal closes.',
    key_label: 'Your key (private)', hot_role_hint: 'Kept in this browser and on your recovery sheet.',
    // fresh device
    fd_head: 'Open this deal on this device',
    fd_hint: 'This browser has no key for the deal. Take your recovery sheet and enter the key and the service token from it.',
    fd_key: 'Your key (from the sheet)', fd_token: 'Service token (from the sheet)', fd_chat: 'Chat key (optional — enables the deal chat)',
    fd_open: 'Open deal', fd_opening: 'opening…',
    fd_err: 'Could not open the deal — check the key and the token against the sheet.',
    fd_bad_key: 'The key must be 64 hex characters.',
    // loading a deal on a new device/browser (recovery sheet .txt or manual input)
    ld_head: 'Open an existing deal',
    ld_hint: 'On a new device? Load your recovery sheet (.txt) and it fills in everything — or type the details from it below.',
    ld_sheet_btn: 'Load recovery sheet (.txt)',
    ld_or: 'or enter it manually:',
    ld_id: 'Deal number',
    ld_bad_id: 'Enter the deal number from your recovery sheet.',
    // chat
    chat_title: 'Deal chat',
    chat_send: 'Send',
    chat_placeholder: 'Type a message…',
    chat_funding: 'Chat is being funded on-chain — usually under a minute. Messages unlock as soon as the dust arrives.',
    chat_empty: 'No messages yet. Start the conversation.',
    chat_key_label: 'Chat key (does NOT move funds)',
    chat_peer_missing: 'The other party has not joined the chat yet.',
    chat_after_fund: 'The deal chat opens right after the escrow is funded — messages live on-chain, so the chat keys get their dust once funding arrives.',
    chat_unavailable: 'Chat is not available for this deal (created before deal chat existed).',
    chat_hint: 'On-chain messaging on the Kaspa BlockDAG (Kasia protocol): end-to-end encrypted, every message is a transaction — impossible to forge or backdate. The server relays only ciphertext.',
    chat_attach: 'Attach a photo, video or PDF',
    chat_sending: 'sending…',
    chat_readonly: 'Deal closed — the chat is read-only.',
    chat_expand: 'Show conversation ▸',
    chat_collapse: 'Hide conversation ▾',
    anchor_title: 'On-chain anchor of this message',
    decrypt_err: '(cannot decrypt this message)',
    // media
    m_photo: 'Photo', m_video: 'Video', m_doc: 'PDF',
    m_load: (s) => `Load ${s}`,
    m_open: 'Open', m_save: 'Save',
    m_encrypting: 'encrypting…',
    m_uploading: (p) => `uploading ${p}%`,
    m_downloading: (p) => `downloading ${p}%`,
    m_decrypting: 'decrypting…',
    m_sent_meta: 'encrypted · hash anchored on-chain',
    m_hash_ok: 'hash matches the on-chain anchor',
    m_hash_fail: 'Integrity check FAILED — the file does not match the on-chain hash. Not displaying it.',
    m_too_big_img: 'Image is too big — beta limit is 10 MB.',
    m_too_big_vid: 'Video is too big — beta limit is 50 MB.',
    m_too_big_doc: 'PDF is too big — beta limit is 20 MB.',
    m_bad_type: 'Only images (jpg / png / webp / gif), video (mp4 / webm) and PDF documents are supported.',
    // tracking number (goods deals)
    track_btn_title: 'Add a tracking number',
    track_head: 'Tracking number',
    track_carrier: 'Carrier',
    track_code_ph: 'e.g. RA123456789RU',
    track_send: 'Send tracking number',
    track_cancel: 'Cancel',
    track_bad_code: 'Tracking number: 5–40 characters, letters / digits / dashes.',
    track_s10_fail: 'Checksum FAILED — this does not look like a real international (S10) tracking number. Double-check it. Send anyway?',
    track_bubble: 'Tracking number',
    track_copy: 'Copy', track_copied: 'copied',
    track_open: 'Track package',
    track_sent_meta: 'anchored on-chain — timestamp cannot be forged',
    track_unboxing_hint: '🎥 Tip: when the parcel arrives, record ONE continuous unboxing video — sealed box with the shipping label in frame, then the contents. If the wrong item is inside, that video is your strongest evidence in a dispute (a valid tracking number only proves shipment, not what was in the box). Send it to this chat.',
    track_win_guard: (t) => `⚠️ The dispute window closes in ${t} and the goods are not confirmed as received. If you have NOT received your order, open a dispute BEFORE the window closes — after that the funds auto-release to the seller.`,
    // OTC: payment details + payment claim
    payto_btn_title: 'Share payment details',
    payto_head: 'Payment details',
    payto_method: 'Method',
    payto_details_ph: 'address / phone / card number',
    payto_send: 'Share details',
    payto_bubble: 'Payment details',
    payto_hint_payer: '💡 Send the payment ONLY to these details from the deal chat. Keep the receipt with the operation ID — in a dispute it is your evidence.',
    pay_btn_title: 'I have paid',
    pay_head: 'Payment sent',
    pay_ref: 'Reference (txid / operation ID)',
    pay_ref_ph: 'txid or bank operation ID',
    pay_amount: 'Amount',
    pay_amount_ph: 'e.g. 500',
    pay_currency_ph: 'USDT',
    pay_send: 'Send payment claim',
    pay_bubble: 'Payment claimed',
    pay_explorer: 'Open in explorer',
    pay_hint_receiver: '⚠️ Sign the release ONLY after the money actually arrives in your wallet / account. A screenshot is not a deposit; pressure like “I’ve sent it, release now” is a classic scam.',
    pay_bad_fields: 'Fill in the reference (5–100 characters) and amount.',
    m_upload_err: 'Upload failed', m_download_err: 'Download failed',
    m_cancel: 'Cancel', m_retry: 'Retry', m_dismiss: 'Dismiss',
    m_media_off: 'Media is not enabled on this deployment yet.',
    // dispute resolution (Phase 2: claims → reveal → AI verdict → signature)
    disp_flow_hint: 'Both parties state their claims → the AI mediator reads the revealed chat and proposes an outcome → a party accepts it with their signature. The server never moves funds. Not accepted in 24 h — a human arbiter takes over.',
    disp_step_claims: 'claims', disp_step_reveal: 'reveal', disp_step_verdict: 'verdict', disp_step_sign: 'signature', disp_step_human: 'human',
    disp_claim_q: 'What outcome do you ask for?',
    disp_opt_mine_buyer: 'Refund to me', disp_opt_mine_seller: 'Payout to me',
    disp_opt_split: 'Split it', disp_opt_concede_buyer: 'Release to seller', disp_opt_concede_seller: 'Refund the buyer',
    disp_reason_lbl: 'Why — facts decide',
    disp_reason_ph: 'Lean on what the mediator can check: tracking number, payment screenshot, an unboxing video, links. The deal chat below is your evidence — it is what gets revealed to the arbiter.',
    disp_send_claim: 'Submit claim', disp_claim_sending: 'submitting…',
    disp_claim_missing: 'Pick the outcome you ask for.',
    disp_wait_other: 'Claim submitted. Waiting for the other party — the mediator starts once both claims are in.',
    disp_you_ask: (o) => `You ask for: ${o}.`,
    disp_req_refund: 'refund to the buyer', disp_req_release: 'payout to the seller', disp_req_split: 'a split',
    disp_reveal_head: 'Reveal the chat to the mediator',
    disp_reveal_warn: 'The AI mediator judges by the deal chat. The button below sends your CHAT KEY to the server. It only decrypts messages — it can never move funds. Your escrow key stays on this device. One party\'s key opens the whole thread.',
    disp_reveal_btn: 'Reveal chat to the arbiter', disp_revealing: 'revealing…',
    disp_reveal_nokey: 'The chat key is not on this device, so revealing from here is impossible. The other party can reveal from their side — one key is enough.',
    disp_reveal_status: (you, peer) => `Revealed: you ${you} · other party ${peer}`,
    disp_verdict_wait: 'Chat revealed. The mediator is reading the thread — the verdict will appear here.',
    disp_verdict_head: 'AI mediator\'s verdict',
    disp_verdict_nonbinding: 'A non-binding recommendation — nothing moves until a party signs (or, past the window, a human arbiter rules).',
    disp_out_refund: 'Refund to the buyer', disp_out_release: 'Payout to the seller',
    disp_out_split: (n) => `Split: ${n}% to the buyer · ${100 - n}% to the seller`,
    disp_amount_buyer: 'buyer receives', disp_amount_seller: 'seller receives',
    disp_reason_head: 'Reasoning',
    disp_window: (t) => `Time to accept: ${t}`,
    disp_window_hint: 'If the verdict is not accepted in time, the dispute escalates to a human arbiter.',
    disp_window_over: 'The window is over — escalation to the human arbiter is imminent.',
    disp_accept_sign: 'Accept & sign', disp_signing: 'signing…',
    disp_agree: 'I agree', disp_escalating: 'escalating…',
    disp_escalate_btn: 'Escalate to arbiter',
    disp_escalate_confirm: 'Reject the AI verdict and hand the dispute to a human arbiter? The deal escalates immediately — no 24h wait.',
    disp_agree_wait: (r) => `You accepted the verdict. Waiting for ${r} to sign the payout.`,
    disp_confirm_refund: 'Sign the refund? ALL escrowed funds go to the buyer. This is final.',
    disp_confirm_release: 'Sign the release? ALL escrowed funds go to the seller. This is final.',
    disp_confirm_split: (b, s) => `Sign the split? Buyer gets ${b}, seller gets ${s}. It executes once the other party co-signs.`,
    disp_gen_buyer: 'the buyer', disp_gen_seller: 'the seller',
    disp_wait_peer_sign: (r) => `This verdict is executed by ${r}\'s signature — waiting for them to sign. Disagree? Don\'t sign: past the window the dispute goes to a human arbiter.`,
    disp_split_wait_peer: 'Your signature is saved. Waiting for the other party to co-sign — the split submits automatically once both signatures are in.',
    disp_split_closing: 'Both signatures are in — submitting the split…',
    disp_split_too_small: 'Each share must be at least 1 KAS — this split cannot execute on-chain. Settle with a full release or refund instead.',
    disp_escalated: 'The deal has been sent to a live arbiter for review. You\'ll get a Telegram notification, or the deal status will update here — nothing more to do for now.',
    disp_rejected_tag: 'rejected by a party',
    arb_done_head: 'Arbiter\'s decision',
    arb_done_buyer: 'Funds returned to the buyer',
    arb_done_seller: 'Funds released to the seller',
    arb_done_split: (n) => `Split: ${n}% to the buyer · ${100 - n}% to the seller`,
    disp_timeout_line: (t, side) => `Contract failsafe: no resolution within ${t} — the escrow returns everything to the ${side} by itself, no signatures and no service fee. The deal can never hang.`,
    disp_timeout_soon: 'Contract failsafe is about to fire — the escrow is returning everything to the default side by itself.',
    disp_timeout_buyer: 'buyer', disp_timeout_seller: 'seller',
    copy_ok: 'ok', copy: 'copy',
  },
  ru: {
    brand: 'Kaspa <b>Гарант</b>',
    role_buyer: 'Я покупатель', role_seller: 'Я продавец',
    noun_buyer: 'покупатель', noun_seller: 'продавец',
    tpl_goods: 'Товар', tpl_otc: 'OTC / обмен крипты', tpl_service: 'Услуга / фриланс',
    beta_cap: 'Бета-лимиты: от 50 до 10 000 KAS на сделку.',
    amount_err: 'Введите сумму от 50 до 10 000 KAS.',
    fee_arb_share: (p) => `Обратите внимание: если дойдёт до арбитра, его комиссия — около ${p}% суммы: на мелких сделках арбитраж дорог. Списывается только если спор дошёл до вердикта.`,
    creating: 'создаём…', gen_invite: 'Создать ссылку-приглашение',
    fee_line: (r, dp) => `Комиссия сервиса: <b>${r}</b> при релизе/возврате, <b>${dp}</b> при арбитраже.`,
    fee_head: 'Комиссия сервиса', fee_amicable: 'Релиз или возврат (без спора)', fee_arb: 'Спор ушёл арбитру',
    fee_rate_resolve: '0,5% · мин 1,2 KAS', fee_rate_dispute: '2% · мин 5 KAS',
    fee_enter_amount: 'Введите сумму — покажем точную комиссию.',
    fund_you_pay: 'Вы платите', fund_seller_gets: 'Продавец получит',
    win_pick_hint: 'Пока окно открыто, покупатель может открыть спор; закрылось — эскроу сам уходит продавцу. По умолчанию окно подобрано под тип сделки — выбирайте своё.',
    invite_ready: 'Сделка создана. Отправьте ссылку второй стороне:',
    save_sheet: 'Скачать recovery-лист (.txt)',
    ack_sheet: 'Я сохранил recovery-лист. Понимаю: приватный ключ — мой единственный доступ к сделке.',
    open_panel: 'Открыть панель сделки →',
    step_done_terms: 'Условия зафиксированы', step3_hint: 'Панель сделки — рабочее место: финансирование, чат, релиз / спор.',
    deal_title: (n) => `Сделка #${n}`,
    invite_title: 'Приглашение в сделку',
    you_are: (r) => `В этой сделке вы — <b>${r}</b>.`,
    join_btn: 'Сгенерировать ключ и войти', joining: 'входим…',
    join_note: 'Приватный ключ создаётся в этом браузере и не покидает его. При входе скачается recovery-лист (.txt) — это единственная копия.',
    join_window: (t) => `Окно спора: ${t} после финансирования.`,
    addr_mismatch: 'Адрес не совпал — параметры сделки расходятся с сервером. НЕ финансируйте. Свяжитесь со второй стороной.',
    st_draft: 'черновик', st_joined: 'ждём финансирования', st_funded: 'профинансирована', st_disputed: 'в споре', st_closed: 'закрыта', st_expired: 'истекла',
    lbl_status: 'Статус', lbl_you_are: 'Ваша роль', lbl_amount: 'Сумма', lbl_type: 'Тип', lbl_addr: 'Адрес эскроу', lbl_conditions: 'Условия', lbl_window: 'Окно',
    fund_head: 'Профинансировать эскроу', fund_hint: 'Отправьте на адрес ниже сумму, указанную выше — это ВАШ адрес (ключ в recovery-листе). В неё уже включена комиссия сервиса, поэтому продавец получит полную сумму сделки. Как только придёт — браузер сам заложит средства в ончейн-эскроу. Держите страницу открытой.',
    fund_addr_lbl: 'Адрес финансирования (сюда)',
    fund_nokey: 'На этом устройстве нет ключа закладки — финансируйте сделку с устройства, где она создавалась или принималась.',
    fund_recv: 'Получено', fund_send_lbl: 'Сумма к отправке (с комиссией)', fund_wait: 'ждём перевод…', lock_btn: 'Заложить в эскроу', locking: 'закладываем…',
    lock_auto: 'Заложится автоматически, когда придёт перевод',
    seller_wait: 'Ждём, пока покупатель профинансирует эскроу. Вы получите уведомление.',
    win_left: (t) => `Авто-релиз продавцу через ${t}, если не открыть спор.`,
    win_over: 'Окно спора закрылось — вот-вот пройдёт авто-релиз продавцу.',
    act_buyer: 'Получили оплаченное? Отпустите средства. Что-то не так? Откройте спор в течение окна.',
    release_btn: 'Отпустить средства продавцу', dispute_btn: 'Открыть спор',
    act_seller: 'Средства заперты в эскроу. Хотите отменить и вернуть покупателю — используйте возврат.',
    refund_btn: 'Вернуть покупателю',
    disp_head: 'Спор открыт',
    settle_hint: 'Всё ещё можно договориться миром: покупатель может отпустить, продавец — вернуть.',
    closed_head: 'Сделка закрыта',
    closed_resolved: 'Средства покинули эскроу — релиз продавцу или возврат покупателю.',
    closed_arbitrated: 'Спор разрешён — вердиктом арбитра или по дедлайну.',
    closed_by: (k) => `Исход: ${k}.`,
    view_explorer: 'Адрес эскроу на эксплорере →',
    payout_received: 'Возвращено вам',
    withdraw_after_close: 'Средства заперты в ончейн-ковенанте. Вывести свою выплату на свой кошелёк можно только после закрытия сделки (release / refund / арбитраж).',
    payout_hint: 'Средства под вашим ключом сделки. Выведите их на любой свой Kaspa-адрес.',
    payout_to_lbl: 'Ваш адрес для вывода',
    payout_withdraw: 'Вывести средства',
    payout_to_wallet: 'На мой кошелёк',
    payout_no_wallet: 'В профиле этого браузера нет кошелька — откройте деск один раз (или введите адрес вручную).',
    payout_view: 'Ваш адрес на эксплорере →',
    payout_need_addr: 'Укажите Kaspa-адрес для вывода.',
    payout_bad_addr: 'Это не похоже на Kaspa-адрес (должен начинаться с kaspa:).',
    payout_no_key: 'Ключа сделки нет на этом устройстве — откройте сделку с recovery-листа, чтобы вывести.',
    payout_confirm: (to) => `Вывести все средства на\n${to}?`,
    payout_sending: 'Отправка…',
    payout_sent: 'Отправлено ✓ — средства в пути',
    payout_empty: 'Выводить нечего (уже выведено?).',
    payout_done: '✓ Средства успешно выведены',
    payout_done_tx: 'Транзакция вывода на эксплорере →',
    confirm_release: 'Отпустить все средства продавцу? Это окончательно.',
    confirm_dispute: 'Открыть спор? Средства замрут до вердикта арбитра или дедлайна.',
    dispute_confirm_note: 'Открытие спора переводит сделку в статус СПОРНАЯ, подключает ИИ-медиатора и открывает вашу переписку арбитру для рассмотрения. Подпишите, чтобы продолжить.',
    dispute_sign_open: 'Подписать и открыть чат для арбитра',
    disp_cancel: 'Отмена',
    disp_opened_warn: '⚠️ Покупатель открыл спор. Сделка теперь спорная, подключён ИИ-медиатор — изложите свою позицию ниже.',
    confirm_refund: 'Вернуть все средства покупателю? Это окончательно.',
    tg_btn: 'Подключить Telegram', tg_hint: (b, c) => `Отправьте <span class="mono">/start ${c}</span> боту <a href="https://t.me/${b}?start=${c}" target="_blank" rel="noopener">@${b}</a>.`,
    no_deal: 'Сделка не найдена. Создайте новую или откройте ссылку-приглашение.',
    // deal portfolio in this browser (mirrors the safe pattern)
    deals_bar_title: 'Мои сделки', deal_new: '+ Новая сделка',
    deals_done_toggle: (n) => `Завершённые (${n})`,
    db_rename: 'Название сделки (видно только в этом браузере):',
    forget_deal: 'Удалить эту сделку из браузера',
    forget_deal_confirm: 'Удалить эту сделку из этого браузера? Ключ уйдёт вместе с ней — вернуться можно будет только по recovery-листу (.txt).',
    forget_locked: 'Сделка активна — ключ нужен для release/refund или спора. Удаление станет доступно после закрытия.',
    key_label: 'Ваш ключ (приватный)', hot_role_hint: 'Хранится в этом браузере и в recovery-листе.',
    fd_head: 'Открыть сделку на этом устройстве',
    fd_hint: 'В этом браузере нет ключа сделки. Возьмите recovery-лист и введите из него ключ и сервисный токен.',
    fd_key: 'Ваш ключ (из листа)', fd_token: 'Сервисный токен (из листа)', fd_chat: 'Ключ чата (необязательно — включит чат сделки)',
    fd_open: 'Открыть сделку', fd_opening: 'открываем…',
    fd_err: 'Не удалось открыть сделку — сверьте ключ и токен с листом.',
    fd_bad_key: 'Ключ — это 64 hex-символа.',
    // loading a deal on a new device/browser (recovery sheet .txt or manual input)
    ld_head: 'Открыть существующую сделку',
    ld_hint: 'Новое устройство? Загрузите recovery-лист (.txt) — он заполнит всё сам, или введите данные из него вручную ниже.',
    ld_sheet_btn: 'Загрузить recovery-лист (.txt)',
    ld_or: 'или введите вручную:',
    ld_id: 'Номер сделки',
    ld_bad_id: 'Введите номер сделки из recovery-листа.',
    chat_title: 'Чат сделки',
    chat_send: 'Отправить',
    chat_placeholder: 'Введите сообщение…',
    chat_funding: 'Чат финансируется ончейн — обычно меньше минуты. Сообщения откроются, как только придёт пыль.',
    chat_empty: 'Сообщений пока нет. Начните переписку.',
    chat_key_label: 'Ключ чата (НЕ двигает средства)',
    chat_peer_missing: 'Вторая сторона ещё не подключила чат.',
    chat_after_fund: 'Чат сделки откроется сразу после финансирования эскроу — сообщения живут ончейн, пыль на чат-ключи приходит вместе с фандингом.',
    chat_unavailable: 'Чат недоступен для этой сделки (создана до появления чата).',
    chat_hint: 'Ончейн-общение в BlockDAG Kaspa (протокол Kasia): сквозное шифрование, каждое сообщение — транзакция, подделать или дописать нельзя. Сервер видит только шифртекст.',
    chat_attach: 'Прикрепить фото, видео или PDF',
    chat_sending: 'отправка…',
    chat_readonly: 'Сделка закрыта — чат только для чтения.',
    chat_expand: 'Развернуть переписку ▸',
    chat_collapse: 'Свернуть ▾',
    anchor_title: 'Ончейн-якорь этого сообщения',
    decrypt_err: '(не удалось расшифровать сообщение)',
    m_photo: 'Фото', m_video: 'Видео', m_doc: 'PDF',
    m_load: (s) => `Загрузить ${s}`,
    m_open: 'Открыть', m_save: 'Сохранить',
    m_encrypting: 'шифруем…',
    m_uploading: (p) => `загрузка ${p}%`,
    m_downloading: (p) => `скачивание ${p}%`,
    m_decrypting: 'расшифровка…',
    m_sent_meta: 'зашифровано · хеш заякорен ончейн',
    m_hash_ok: 'хеш совпал с ончейн-якорем',
    m_hash_fail: 'Проверка целостности НЕ пройдена — файл не совпадает с ончейн-хешем. Не показываем.',
    m_too_big_img: 'Изображение слишком большое — бета-лимит 10 МБ.',
    m_too_big_vid: 'Видео слишком большое — бета-лимит 50 МБ.',
    m_too_big_doc: 'PDF слишком большой — бета-лимит 20 МБ.',
    m_bad_type: 'Поддерживаются изображения (jpg / png / webp / gif), видео (mp4 / webm) и PDF-документы.',
    // tracking number (goods deals)
    track_btn_title: 'Добавить трек-номер',
    track_head: 'Трек-номер',
    track_carrier: 'Перевозчик',
    track_code_ph: 'например RA123456789RU',
    track_send: 'Отправить трек-номер',
    track_cancel: 'Отмена',
    track_bad_code: 'Трек-номер: 5–40 символов, буквы / цифры / дефисы.',
    track_s10_fail: 'Чексумма НЕ сошлась — это не похоже на настоящий международный (S10) трек-номер. Проверьте его. Отправить всё равно?',
    track_bubble: 'Трек-номер',
    track_copy: 'Копировать', track_copied: 'скопировано',
    track_open: 'Отследить посылку',
    track_sent_meta: 'заякорено ончейн — время добавления не подделать',
    track_unboxing_hint: '🎥 Совет: при получении снимите ОДНО непрерывное видео вскрытия — запечатанная коробка с этикеткой в кадре, затем содержимое. Если внутри не то — это ваше главное доказательство в споре (валидный трек доказывает только отправку, не содержимое посылки). Пришлите его в этот чат.',
    track_win_guard: (t) => `⚠️ Окно споров закроется через ${t}, а получение товара не подтверждено. Если заказ НЕ пришёл — откройте спор ДО закрытия окна: после него средства автоматически уйдут продавцу.`,
    // OTC: payment details + payment claim
    payto_btn_title: 'Дать реквизиты для оплаты',
    payto_head: 'Реквизиты для оплаты',
    payto_method: 'Способ',
    payto_details_ph: 'адрес / телефон / номер карты',
    payto_send: 'Отправить реквизиты',
    payto_bubble: 'Реквизиты для оплаты',
    payto_hint_payer: '💡 Переводите ТОЛЬКО на эти реквизиты из чата сделки. Сохраните квитанцию с номером операции — при споре это ваше доказательство.',
    pay_btn_title: 'Я оплатил',
    pay_head: 'Платёж отправлен',
    pay_ref: 'Референс (txid / № операции)',
    pay_ref_ph: 'txid или номер операции банка',
    pay_amount: 'Сумма',
    pay_amount_ph: 'напр. 500',
    pay_currency_ph: 'USDT',
    pay_send: 'Отправить заявление об оплате',
    pay_bubble: 'Заявлена оплата',
    pay_explorer: 'Открыть в эксплорере',
    pay_hint_receiver: '⚠️ Подписывайте release ТОЛЬКО после реального зачисления на ваш кошелёк/счёт. Скриншот — не зачисление; давление «я перевёл, отпускай» — классика скама.',
    pay_bad_fields: 'Заполните референс (5–100 символов) и сумму.',
    m_upload_err: 'Загрузка не удалась', m_download_err: 'Скачивание не удалось',
    m_cancel: 'Отмена', m_retry: 'Повторить', m_dismiss: 'Убрать',
    m_media_off: 'Медиа на этом развёртывании ещё не включено.',
    // dispute resolution (Phase 2: claims → reveal → AI verdict → signature)
    disp_flow_hint: 'Обе стороны подают заявления → ИИ-медиатор читает раскрытую переписку и предлагает исход → сторона принимает его своей подписью. Сервер средства не двигает. Нет принятия за 24 ч — подключается человек-арбитр.',
    disp_step_claims: 'заявления', disp_step_reveal: 'раскрытие', disp_step_verdict: 'вердикт', disp_step_sign: 'подпись', disp_step_human: 'человек',
    disp_claim_q: 'Какого исхода вы требуете?',
    disp_opt_mine_buyer: 'Вернуть деньги мне', disp_opt_mine_seller: 'Выплатить мне',
    disp_opt_split: 'Разделить', disp_opt_concede_buyer: 'Отдать продавцу', disp_opt_concede_seller: 'Вернуть покупателю',
    disp_reason_lbl: 'Почему — решают факты',
    disp_reason_ph: 'Опирайтесь на проверяемое: трек-номер, скрин оплаты, видео вскрытия, ссылки. Чат сделки ниже — ваши доказательства, именно он раскрывается арбитру.',
    disp_send_claim: 'Отправить заявление', disp_claim_sending: 'отправка…',
    disp_claim_missing: 'Выберите требуемый исход.',
    disp_wait_other: 'Заявление отправлено. Ждём вторую сторону — медиатор начнёт, когда будут оба заявления.',
    disp_you_ask: (o) => `Вы требуете: ${o}.`,
    disp_req_refund: 'возврат покупателю', disp_req_release: 'выплату продавцу', disp_req_split: 'раздел',
    disp_reveal_head: 'Раскрыть переписку медиатору',
    disp_reveal_warn: 'ИИ-медиатор судит по чату сделки. Кнопка ниже отправит на сервер ваш КЛЮЧ ЧАТА. Он расшифровывает только сообщения — двигать средства им НЕЛЬЗЯ. Эскроу-ключ остаётся на этом устройстве. Ключа одной стороны хватает на весь тред.',
    disp_reveal_btn: 'Раскрыть переписку арбитру', disp_revealing: 'раскрываем…',
    disp_reveal_nokey: 'Ключа чата нет на этом устройстве — раскрыть отсюда не выйдет. Вторая сторона может раскрыть со своей: одного ключа достаточно.',
    disp_reveal_status: (you, peer) => `Раскрыто: вы ${you} · вторая сторона ${peer}`,
    disp_verdict_wait: 'Переписка раскрыта. Медиатор читает тред — вердикт появится здесь.',
    disp_verdict_head: 'Вердикт ИИ-медиатора',
    disp_verdict_nonbinding: 'Необязывающая рекомендация — ничего не двигается, пока сторона не подпишет (а после окна — рассудит человек-арбитр).',
    disp_out_refund: 'Вернуть покупателю', disp_out_release: 'Выплатить продавцу',
    disp_out_split: (n) => `Раздел: ${n}% покупателю · ${100 - n}% продавцу`,
    disp_amount_buyer: 'покупатель получит', disp_amount_seller: 'продавец получит',
    disp_reason_head: 'Обоснование',
    disp_window: (t) => `На принятие: ${t}`,
    disp_window_hint: 'Если вердикт не принять в срок, спор уйдёт человеку-арбитру.',
    disp_window_over: 'Окно вышло — вот-вот передадим спор человеку-арбитру.',
    disp_accept_sign: 'Принять и подписать', disp_signing: 'подписываем…',
    disp_agree: 'Согласен', disp_escalating: 'эскалация…',
    disp_escalate_btn: 'Эскалация к арбитру',
    disp_escalate_confirm: 'Отклонить вердикт ИИ и передать спор человеку-арбитру? Сделка сразу перейдёт в эскалацию — без ожидания 24ч.',
    disp_agree_wait: (r) => `Вы приняли вердикт. Ждём, пока ${r} подпишет выплату.`,
    disp_confirm_refund: 'Подписать возврат? ВСЕ средства эскроу уйдут покупателю. Это окончательно.',
    disp_confirm_release: 'Подписать выплату? ВСЕ средства эскроу уйдут продавцу. Это окончательно.',
    disp_confirm_split: (b, s) => `Подписать раздел? Покупателю ${b}, продавцу ${s}. Исполнится, когда со-подпишет вторая сторона.`,
    disp_gen_buyer: 'покупателя', disp_gen_seller: 'продавца',
    disp_wait_peer_sign: (r) => `Этот вердикт исполняет подпись ${r} — ждём её. Не согласны? Просто не подписывайте: после окна спор уйдёт человеку-арбитру.`,
    disp_split_wait_peer: 'Ваша подпись сохранена. Ждём со-подпись второй стороны — раздел отправится автоматически, когда будут обе.',
    disp_split_closing: 'Обе подписи получены — отправляем раздел…',
    disp_split_too_small: 'Каждая доля должна быть не меньше 1 KAS — такой раздел ончейн не исполнить. Договоритесь о полном релизе или возврате.',
    disp_escalated: 'Сделка отправлена на рассмотрение живому арбитру. Вам придёт уведомление в Telegram или обновится статус сделки здесь — больше ничего делать не нужно.',
    disp_rejected_tag: 'отклонён стороной',
    arb_done_head: 'Решение арбитра',
    arb_done_buyer: 'Средства возвращены покупателю',
    arb_done_seller: 'Средства отправлены продавцу',
    arb_done_split: (n) => `Сплит: ${n}% покупателю · ${100 - n}% продавцу`,
    disp_timeout_line: (t, side) => `Аварийный контур контракта: если развязки не будет за ${t}, эскроу сам вернёт всё ${side} — без подписей и без комиссии сервиса. Сделка не может зависнуть.`,
    disp_timeout_soon: 'Аварийный контур вот-вот сработает — эскроу сам возвращает всё стороне по умолчанию.',
    disp_timeout_buyer: 'покупателю', disp_timeout_seller: 'продавцу',
    copy_ok: 'ок', copy: 'копир.',
  },
};
export function L(key) { return (DICT[lang()] || DICT.en)[key] ?? DICT.en[key] ?? key; }

// ── DOM/utilities ──
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function copyText(btn, text) {
  btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text()); const t = btn.textContent; btn.textContent = L('copy_ok'); setTimeout(() => (btn.textContent = t), 900); } catch {}
  });
}
export function qrInto(el, data) {
  if (typeof qrcode === 'undefined') return;
  if (el.dataset.qr === data) return;   // same QR already drawn — don't redraw on polling (otherwise the image flickers every 6s)
  const q = qrcode(0, 'M'); q.addData(data); q.make();
  el.innerHTML = q.createImgTag(4, 8);
  el.dataset.qr = data;
}
export function showErr(el, e) { el.textContent = '⚠ ' + (e.message || e); el.style.display = 'block'; }
export function hideErr(el) { el.style.display = 'none'; }
export function templateLabel(t) { return { goods: L('tpl_goods'), otc: L('tpl_otc'), service: L('tpl_service') }[t] || t; }
export function daaHuman(daa) {
  const h = daa / 36000;
  if (h < 48) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(0)}d`;
}
// Human-readable dispute window: DAA → "≈ 2 d 3 h" / "≈ 3 h 12 min" (mainnet: 10 DAA ≈ 1 sec).
export function daaLeftHuman(daaLeft) {
  const ru = lang() === 'ru';
  const secs = Math.max(0, Math.floor(daaLeft / 10));
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
  const U = ru ? { d: 'д', h: 'ч', m: 'мин' } : { d: 'd', h: 'h', m: 'm' };
  if (d > 0) return `≈ ${d} ${U.d} ${h} ${U.h}`;
  if (h > 0) return `≈ ${h} ${U.h} ${m} ${U.m}`;
  return `≈ ${m} ${U.m}`;
}
// Escrow age in DAA from funded_at (sec): mainnet ~10 blocks/sec. Rough UI estimate;
// the precise gate is consensus.
export function escrowAgeDaa(fundedAt) {
  if (!fundedAt) return 0;
  return Math.max(0, Math.floor(Date.now() / 1000) - fundedAt) * 10;
}
// Explorer (mainnet only — test nets have no public one). Address is not URL-encoded:
// kaspa:… contains only [a-z0-9:], ":" is legal in a path and the explorer expects it raw.
export function explorerAddr(addr) {
  return net() === 'mainnet' && addr ? `https://kaspa.stream/addresses/${addr}` : null;
}
export function explorerTx(txid) {
  return net() === 'mainnet' && txid ? `https://kaspa.stream/transactions/${encodeURIComponent(txid)}` : null;
}

// ── local deal store: via the single encrypted profile (session) ──
// Portfolio: array of deals in session + active id in LSA (mirrors the safe vault portfolio).
const LSA = 'kaspa-escrow-active';    // id of the active deal (which one to open by default)
export function loadDeals() { return getDeals(); }        // session is unlocked by the page's boot guard
export function saveDeals(arr) { setDeals(arr); }         // no plaintext mirror (it used to hold the private sk!)
export function saveDeal(d) {
  const arr = loadDeals();
  const i = arr.findIndex((x) => x.id === d.id);
  // Do NOT resurrect a forgotten deal: "Forget" races the deal page's background writers
  // (6-sec refresh() polling, debounced chatRead) — their saveDeal upsert, landing after
  // removeDeal(), silently put the deal back into the profile (owner-reported bug, 2026-07-11).
  // Updating an existing record leaves the tombstone alone; explicit return flows clear the mark via unforgetDeal().
  if (i < 0 && forgottenDealIds().includes(Number(d.id))) return;
  if (i >= 0) arr[i] = { ...arr[i], ...d }; else arr.push(d);
  saveDeals(arr);
  localStorage.setItem(LSA, String(d.id)); // an opened/saved deal becomes the active one
}
export function loadDeal(id) { return loadDeals().find((d) => d.id === Number(id)) || null; }
export function activeDealId() { const v = Number(localStorage.getItem(LSA)); return Number.isFinite(v) && v > 0 ? v : null; }
export function setActiveDeal(id) { localStorage.setItem(LSA, String(id)); }
// Forget a deal in this browser (the key goes with it — only the recovery sheet grants access after).
// Returns the remaining list; if the active one was removed, the first remaining becomes active.
export function removeDeal(id) {
  id = Number(id);
  const arr = loadDeals().filter((d) => d.id !== id);
  saveDeals(arr);
  const t = forgottenDealIds();
  if (!t.includes(id)) { t.push(id); localStorage.setItem(LSF, JSON.stringify(t.slice(-200))); }
  if (activeDealId() === id) {
    if (arr.length) localStorage.setItem(LSA, String(arr[0].id));
    else localStorage.removeItem(LSA);
  }
  return arr;
}
// Tombstone of forgotten deals (device-local, like LSA): removeDeal marks the id, saveDeal refuses
// to re-insert a marked one. Cleared by explicit user actions: join/restore from a
// recovery sheet (deal.html) and importing a key file that contains the deal (desk.html).
const LSF = 'kaspa-escrow-forgotten';
export function forgottenDealIds() {
  try { const a = JSON.parse(localStorage.getItem(LSF)); return Array.isArray(a) ? a.map(Number) : []; } catch { return []; }
}
export function unforgetDeal(id) {
  const rest = forgottenDealIds().filter((x) => x !== Number(id));
  if (rest.length) localStorage.setItem(LSF, JSON.stringify(rest)); else localStorage.removeItem(LSF);
}

// cfg string for the wasm core, built from a stored deal
export function cfgStr(cfg) {
  return JSON.stringify({
    buyer_pk: cfg.buyer_pk, seller_pk: cfg.seller_pk, arbiter_pk: cfg.arbiter_pk,
    dispute_window: cfg.dispute_window, arbiter_deadline: cfg.arbiter_deadline, timeout_to: cfg.timeout_to,
    fee_pk: cfg.fee_pk, fee_resolve: cfg.fee_resolve, fee_dispute: cfg.fee_dispute,
  });
}

// raw /utxos text (for wasm)
export async function utxosRaw(address) {
  const r = await fetch(new URL(`/api/safe/utxos?address=${encodeURIComponent(address)}`, location.origin));
  const t = await r.text();
  if (!r.ok) throw new Error('node unavailable');
  return t;
}
export async function submitTx(builtJsonString) {
  const built = JSON.parse(builtJsonString);
  return api('/api/safe/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: built.tx }) });
}

// deal recovery sheet (the only copy of the party's keys)
export function dealSheet(d) {
  const ru = lang() === 'ru';
  if (!d.escrow_addr) d = { ...d, escrow_addr: ru ? '(появится после join — см. панель)' : '(pending join — see the deal panel)' };
  const lines = ru ? [
    'KASPA ГАРАНТ — RECOVERY-ЛИСТ СДЕЛКИ (ЕДИНСТВЕННАЯ КОПИЯ КЛЮЧЕЙ)',
    '='.repeat(60),
    `Сделка: #${d.id}`, `Ваша роль: ${d.role === 'buyer' ? 'покупатель' : 'продавец'}`, `Сеть: ${d.network}`,
    `Сумма: ${(d.amount / 1e8)} KAS`, `Адрес эскроу: ${d.escrow_addr}`, '',
    `Ваш ключ:        ${d.sk}`,
    d.funding_sk ? `Ключ закладки:   ${d.funding_sk}` : null,
    d.chat_sk ? `Ключ чата:       ${d.chat_sk}   (НЕ двигает средства — только переписка)` : null,
    `Сервисный токен: ${d.token}`, '',
    'Панель сделки: https://kaspaforge.org/ru/deal.html?id=' + d.id,
    'Открытый код и офлайн-инструмент: https://github.com/pcdoctormsk-ctrl/kaspa-safe',
    '', 'ХРАНИ ЭТОТ ЛИСТ. Потеря ключа = потеря доступа к своей стороне сделки.',
  ] : [
    'KASPA ESCROW — DEAL RECOVERY SHEET (THE ONLY COPY OF YOUR KEYS)',
    '='.repeat(60),
    `Deal: #${d.id}`, `Your role: ${d.role}`, `Network: ${d.network}`,
    `Amount: ${(d.amount / 1e8)} KAS`, `Escrow address: ${d.escrow_addr}`, '',
    `Your key:       ${d.sk}`,
    d.funding_sk ? `Funding key:    ${d.funding_sk}` : null,
    d.chat_sk ? `Chat key:       ${d.chat_sk}   (does NOT move funds — messaging only)` : null,
    `Service token:  ${d.token}`, '',
    'Deal panel: https://kaspaforge.org/deal.html?id=' + d.id,
    'Open source & offline tool: https://github.com/pcdoctormsk-ctrl/kaspa-safe',
    '', 'KEEP THIS SHEET. Losing the key means losing access to your side of the deal.',
  ];
  return lines.filter((x) => x != null).join('\n');
}
export function downloadSheet(d) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([dealSheet(d)], { type: 'text/plain' }));
  a.download = `kaspa-escrow-deal-${d.id}.txt`;
  a.click();
}
// Parse a recovery sheet (.txt, EN/RU) LOCALLY — for opening a deal on a new device.
// Returns { id, sk, funding_sk, chat_sk, token } (empty fields when the line is absent from the sheet).
export function parseDealSheet(text) {
  const val = {};
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) val[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const pick = (...keys) => { for (const k of keys) if (val[k]) return val[k]; return ''; };
  const hex64 = (s) => (String(s).match(/[0-9a-fA-F]{64}/) || [''])[0].toLowerCase();
  const digits = (s) => (String(s).match(/\d+/) || [''])[0];
  return {
    id: Number(digits(pick('Deal', 'Сделка'))) || null,
    sk: hex64(pick('Your key', 'Ваш ключ')),
    funding_sk: hex64(pick('Funding key', 'Ключ закладки')),
    chat_sk: hex64(pick('Chat key', 'Ключ чата')),
    token: pick('Service token', 'Сервисный токен'),
  };
}

// ── deal chat (Kasia protocol) ──
// Core v4+: chat_gen_keys/chat_address/chat_build_send/chat_decrypt. On an older core
// (missing exports) chat is silently disabled — pages work, the chat panel is hidden.

export function chatSupported() { return typeof core.chat_gen_keys === 'function'; }

/** Generate a chat key, add it to the deal (create/join). Returns chat {sk, pk} or null. */
export function initChat(d) {
  if (!chatSupported()) return null;
  if (d.chat_sk && d.chat_pk) return { sk: d.chat_sk, pk: d.chat_pk };
  // Profile v3: the deal remembers its derivation index (deriv_i) — the chat key is derived
  // from the master seed with the same index and is therefore recoverable from an older backup export.
  let chat = null;
  if (d.deriv_i != null && core.derive_chat_keys) {
    try {
      const seed = session.getProfile().seed;
      if (seed) chat = JSON.parse(core.derive_chat_keys(seed, 'deal/chat', d.deriv_i));
    } catch {}
  }
  if (!chat) chat = JSON.parse(core.chat_gen_keys());
  d.chat_sk = chat.sk;
  d.chat_pk = chat.pk;
  saveDeal(d);
  return chat;
}

/** Address of a chat key (for funding). */
export function chatAddress(pk, n) {
  return core.chat_address(pk, n || net());
}

/** Last delivered msg_id (for since= polling). */
let lastChatMsgId = 0;

/**
 * Poll /chat/thread → decrypt → renderFn for every NEW message (dedup by id).
 * Own messages are NOT rendered optimistically on send — the thread shows them from
 * here exactly once (§11.3). renderFn({id, text, mine, ts, txid}).
 */
export async function pollChat(deal, renderFn) {
  if (!deal.chat_sk) return;
  try {
    const r = await api(`/api/safe/escrow/chat/thread?id=${deal.id}&token=${encodeURIComponent(deal.token)}&since=${lastChatMsgId}`);
    if (!r.msgs || !r.msgs.length) return;
    for (const msg of r.msgs) {
      if (msg.id <= lastChatMsgId) continue;
      const mine = msg.dir === deal.role;
      let text;
      try {
        text = mine
          ? core.chat_decrypt(msg.self_hex, deal.chat_sk)
          : core.chat_decrypt(msg.ciphertext_hex, deal.chat_sk);
      } catch { text = null; }
      renderFn({ id: msg.id, text, mine, ts: msg.ts, txid: msg.txid });
      if (msg.id > lastChatMsgId) lastChatMsgId = msg.id;
    }
  } catch { /* transient */ }
}

/**
 * Send a message: build the comm-tx → ONE submit (§11.1: built.tx; self_tx does not exist,
 * a second submit of the same tx = double-spend and a failed send) → relay ciphertexts to the server.
 */
export async function sendChat(deal, peerChatXonly, text) {
  const addr = chatAddress(deal.chat_pk);
  const u = await utxosRaw(addr);
  const built = JSON.parse(core.chat_build_send(deal.chat_sk, peerChatXonly, deal.role, text, u, net()));
  const res = await submitTx(JSON.stringify({ tx: built.tx }));
  const txid = res.txid || res.id || '';
  await api('/api/safe/escrow/chat/send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: deal.id, token: deal.token, dir: deal.role, txid, ciphertext_hex: built.comm_hex, self_hex: built.self_hex }),
  });
  return txid;
}

/** Reset lastChatMsgId (on panel reload). */
export function resetChatPoll() { lastChatMsgId = 0; }

// ── chat media: photo/video (E2E, off-chain blob, on-chain anchor) ──
// Flow (spec §7): K=media_key() → sha256(file) → ct=media_encrypt(K,file) → POST the blob (raw
// octet-stream) → {media_id} → chat message {t:'media', media_id, k, mime, name, size, sha}
// as regular text (E2E + on-chain anchor). Receive: download blob → media_decrypt → verify sha.
// The key K and the plaintext NEVER reach the server outside E2E ciphertext.

export function mediaSupported() { return typeof core.media_key === 'function'; }

export const MEDIA_IMG_MAX = 10 * 1024 * 1024;   // client-side limit: image ≤ 10 MB (beta)
export const MEDIA_VID_MAX = 50 * 1024 * 1024;   // video ≤ 50 MB (beta); the server enforces the overall cap
export const MEDIA_DOC_MAX = 20 * 1024 * 1024;   // PDF document ≤ 20 MB (beta)
const MIME_IMG = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MIME_VID = ['video/mp4', 'video/webm'];
const MIME_DOC = ['application/pdf'];

/** 'img' | 'vid' | 'doc' | null by mime. */
export function mediaKindOf(mime) {
  if (MIME_IMG.includes(mime)) return 'img';
  if (MIME_VID.includes(mime)) return 'vid';
  if (MIME_DOC.includes(mime)) return 'doc';
  return null;
}

/** Validate a file BEFORE upload: type + size limit. Throws a localized error. */
export function checkMediaFile(file) {
  const kind = mediaKindOf(file.type);
  if (!kind) throw new Error(L('m_bad_type'));
  if (kind === 'img' && file.size > MEDIA_IMG_MAX) throw new Error(L('m_too_big_img'));
  if (kind === 'vid' && file.size > MEDIA_VID_MAX) throw new Error(L('m_too_big_vid'));
  if (kind === 'doc' && file.size > MEDIA_DOC_MAX) throw new Error(L('m_too_big_doc'));
  return kind;
}

/** Read and encrypt a file. → {k, sha, ct, mime, name, size} (all local, K never leaves). */
export async function encryptMediaFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const k = core.media_key();
  const sha = core.sha256_hex(bytes);
  const ct = core.media_encrypt(k, bytes);
  return { k, sha, ct, mime: file.type, name: file.name || 'file', size: file.size };
}

/**
 * Upload the encrypted blob (raw octet-stream, token-gated). XHR — for upload progress.
 * onProgress(0..100). Returns a {media_id, abort()}-compatible promise: the promise has .abort.
 */
export function uploadMedia(deal, ct, onProgress) {
  const xhr = new XMLHttpRequest();
  const p = new Promise((resolve, reject) => {
    xhr.open('POST', `/api/safe/escrow/chat/media?id=${deal.id}&token=${encodeURIComponent(deal.token)}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.responseType = 'text';
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); };
    }
    xhr.onload = () => {
      let j = null;
      try { j = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && j && j.media_id) resolve(j.media_id);
      else reject(new Error((j && j.error) || `${L('m_upload_err')}: ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error(L('m_upload_err')));
    xhr.onabort = () => reject(new Error('aborted'));
    xhr.send(new Blob([ct], { type: 'application/octet-stream' }));
  });
  p.abort = () => { try { xhr.abort(); } catch {} };
  return p;
}

/** Download the encrypted blob with progress. → Uint8Array. */
export async function downloadMedia(deal, mediaId, onProgress) {
  const r = await fetch(`/api/safe/escrow/chat/media?id=${deal.id}&token=${encodeURIComponent(deal.token)}&media_id=${encodeURIComponent(mediaId)}`);
  if (!r.ok) {
    let msg = `${L('m_download_err')}: ${r.status}`;
    try { const j = JSON.parse(await r.text()); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  const total = Number(r.headers.get('content-length')) || 0;
  if (!r.body) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (onProgress && total) onProgress(Math.min(99, Math.round(got / total * 100)));
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  if (onProgress) onProgress(100);
  return out;
}

/** Decrypt the blob and VERIFY sha256 against the on-chain anchor. Mismatch = error, file is not returned. */
export function decryptMediaVerify(k, sha, blobBytes) {
  const pt = core.media_decrypt(k, blobBytes);
  if (core.sha256_hex(pt) !== String(sha).toLowerCase()) throw new Error(L('m_hash_fail'));
  return pt;
}

/** Send the media MESSAGE (metadata+key E2E, on-chain anchor) — after a successful upload. */
export async function sendMediaMsg(deal, peerChatXonly, m, mediaId) {
  const msg = JSON.stringify({ t: 'media', media_id: mediaId, k: m.k, mime: m.mime, name: m.name, size: m.size, sha: m.sha });
  return sendChat(deal, peerChatXonly, msg);
}

/**
 * Detect a media message in decrypted text. Validates fields (hex keys, size,
 * name) — metadata comes from the counterparty and is not trusted. null = regular text.
 */
export function parseMediaMsg(text) {
  if (typeof text !== 'string' || text[0] !== '{' || !text.includes('"media"')) return null;
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || j.t !== 'media') return null;
  const hexOk = (s, len) => typeof s === 'string' && /^[0-9a-fA-F]+$/.test(s) && (!len || s.length === len);
  if (!hexOk(j.media_id) || j.media_id.length > 128) return null;
  if (!hexOk(j.k, 64) || !hexOk(j.sha, 64)) return null;
  const size = Number(j.size);
  if (!(size >= 0 && size <= 60 * 1024 * 1024)) return null;
  const name = String(j.name || 'file').slice(0, 200);
  const mime = String(j.mime || '');
  return { media_id: j.media_id, k: j.k, sha: j.sha.toLowerCase(), mime, name, size, kind: mediaKindOf(mime) };
}

// ── tracking number (goods): structured E2E message {t:'track'} — like media, the server
// sees only ciphertext until reveal; the on-chain anchor fixes the moment it was added
// (KASPA-ESCROW-TRACKING spec). No effect on the contract — an evidence/UX layer. ──

/** Carriers: id → labels (EN/RU) + web tracking (NOT an API — just a "track" link). */
export const CARRIERS = [
  { id: 'pochta', en: 'Russian Post', ru: 'Почта России', url: (c) => `https://www.pochta.ru/tracking#${c}` },
  { id: 'cdek', en: 'CDEK', ru: 'СДЭК', url: (c) => `https://www.cdek.ru/ru/tracking?order_id=${c}` },
  { id: 'dhl', en: 'DHL', ru: 'DHL', url: (c) => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${c}` },
  { id: 'ups', en: 'UPS', ru: 'UPS', url: (c) => `https://www.ups.com/track?tracknum=${c}` },
  { id: 'usps', en: 'USPS', ru: 'USPS', url: (c) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${c}` },
  { id: 'fedex', en: 'FedEx', ru: 'FedEx', url: (c) => `https://www.fedex.com/fedextrack/?trknbr=${c}` },
  { id: 'china-post', en: 'China Post', ru: 'China Post', url: (c) => `https://parcelsapp.com/en/tracking/${c}` },
  { id: 'other', en: 'Other', ru: 'Другой', url: (c) => `https://parcelsapp.com/en/tracking/${c}` },
];
export const carrierOf = (id) => CARRIERS.find((c) => c.id === id) || CARRIERS[CARRIERS.length - 1];
export const carrierLabel = (id) => carrierOf(id)[lang() === 'ru' ? 'ru' : 'en'];

/** Looks like an international S10 number (RA123456789RU)? */
export function looksLikeS10(code) { return /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(code); }

/** S10 checksum (UPU): weights 8,6,4,2,3,5,9,7 over 8 digits, the 9th is the check digit. */
export function s10Valid(code) {
  if (!looksLikeS10(code)) return false;
  const d = code.slice(2, 11).split('').map(Number);
  const w = [8, 6, 4, 2, 3, 5, 9, 7];
  const s = w.reduce((acc, wi, i) => acc + wi * d[i], 0);
  let c = 11 - (s % 11);
  if (c === 10) c = 0;
  if (c === 11) c = 5;
  return c === d[8];
}

/** Normalize the entered code: uppercase, no whitespace. null = fails the base format. */
export function normTrackCode(raw) {
  const code = String(raw || '').toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9-]{5,40}$/.test(code) ? code : null;
}

/** Send a tracking message (E2E + on-chain anchor, like regular text). */
export async function sendTrackMsg(deal, peerChatXonly, carrier, code) {
  const msg = JSON.stringify({ t: 'track', carrier, code });
  return sendChat(deal, peerChatXonly, msg);
}

/** Detect a tracking message in decrypted text (fields come from the counterparty — untrusted). */
export function parseTrackMsg(text) {
  if (typeof text !== 'string' || text[0] !== '{' || !text.includes('"track"')) return null;
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || j.t !== 'track') return null;
  const code = normTrackCode(j.code);
  if (!code) return null;
  const carrier = CARRIERS.some((c) => c.id === j.carrier) ? j.carrier : 'other';
  return { carrier, code, url: carrierOf(carrier).url(encodeURIComponent(code)), label: carrierLabel(carrier),
           s10: looksLikeS10(code) ? s10Valid(code) : null }; // true|false|null(non-S10)
}

// ── OTC: payment details {t:'payto'} and payment claim {t:'pay'} — E2E messages modelled on
// tracking (KASPA-ESCROW-OTC spec). A crypto txid is checked on the explorer during a dispute. ──

/** OTC counter-payment methods: id → labels + explorer for crypto (null = fiat/cash). */
export const PAY_METHODS = [
  { id: 'usdt-trc20', en: 'USDT · TRC20 (Tron)', ru: 'USDT · TRC20 (Tron)', tx: (r) => `https://tronscan.org/#/transaction/${r}` },
  { id: 'usdt-erc20', en: 'USDT · ERC20 (Ethereum)', ru: 'USDT · ERC20 (Ethereum)', tx: (r) => `https://etherscan.io/tx/${r}` },
  { id: 'usdt-bep20', en: 'USDT · BEP20 (BSC)', ru: 'USDT · BEP20 (BSC)', tx: (r) => `https://bscscan.com/tx/${r}` },
  { id: 'sbp', en: 'SBP (fast bank transfer, RU)', ru: 'СБП', tx: null },
  { id: 'card', en: 'Card transfer', ru: 'Перевод на карту', tx: null },
  { id: 'cash', en: 'Cash', ru: 'Наличные', tx: null },
  { id: 'other', en: 'Other', ru: 'Другое', tx: null },
];
export const payMethodOf = (id) => PAY_METHODS.find((m) => m.id === id) || PAY_METHODS[PAY_METHODS.length - 1];
export const payMethodLabel = (id) => payMethodOf(id)[lang() === 'ru' ? 'ru' : 'en'];

const cleanStr = (v, max) => String(v || '').trim().slice(0, max);

/** Buyer: publish payment details for the counter-payment (BEFORE paying — anchored on-chain). */
export async function sendPayToMsg(deal, peerChatXonly, method, details) {
  return sendChat(deal, peerChatXonly, JSON.stringify({ t: 'payto', method, details: cleanStr(details, 200) }));
}

/** Seller: claim the counter-payment (method + reference/txid + amount). */
export async function sendPayMsg(deal, peerChatXonly, method, ref, amount, currency) {
  return sendChat(deal, peerChatXonly, JSON.stringify({
    t: 'pay', method, ref: cleanStr(ref, 100), amount: cleanStr(amount, 20), currency: cleanStr(currency, 10),
  }));
}

/** Detect a payto message (fields come from the counterparty — untrusted). */
export function parsePayToMsg(text) {
  if (typeof text !== 'string' || text[0] !== '{' || !text.includes('"payto"')) return null;
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || j.t !== 'payto') return null;
  const details = cleanStr(j.details, 200);
  if (!details) return null;
  const method = PAY_METHODS.some((m) => m.id === j.method) ? j.method : 'other';
  return { method, details, label: payMethodLabel(method) };
}

/** Detect a pay message. */
export function parsePayMsg(text) {
  if (typeof text !== 'string' || text[0] !== '{' || !text.includes('"pay"')) return null;
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || j.t !== 'pay') return null;
  const ref = cleanStr(j.ref, 100);
  if (ref.length < 5) return null;
  const method = PAY_METHODS.some((m) => m.id === j.method) ? j.method : 'other';
  const m = payMethodOf(method);
  return { method, ref, amount: cleanStr(j.amount, 20), currency: cleanStr(j.currency, 10),
           label: payMethodLabel(method), txUrl: m.tx ? m.tx(encodeURIComponent(ref)) : null };
}

// ── dispute flow (Phase 2): claims → chat-key reveal → AI verdict → party's signature ──
// Spec §0 invariant: of all secrets, ONLY the CHAT key goes to the server, on a deliberate reveal
// (it cannot move funds), plus partial mutual signatures of a split. The escrow key signs locally.

/** Core support for split co-signing (v5+). On an older core the split verdict is shown without buttons. */
export function mutualSupported() { return typeof core.escrow_mutual_sig === 'function'; }

export const MUTUAL_FEE = 1_000_000;  // sompi; = the core's const FEE (escrow_core.rs) — network fee of the mutual tx
export const SPLIT_MIN_OUT = 100_000_000;  // dust guard for split shares (1 KAS; = the contract's MIN_OUT)

export async function disputeState(deal) {
  return api(`/api/safe/escrow/dispute/state?id=${deal.id}&token=${encodeURIComponent(deal.token)}`);
}
// A party rejected the AI verdict → immediate escalation to the human arbiter (no 24h window wait).
export async function escalateDispute(deal) {
  return api('/api/safe/escrow/dispute/escalate', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: deal.id, token: deal.token }) });
}
// After withdrawing funds — notify own side in TG (if subscribed) with a transaction link. Best-effort.
export async function notifyWithdrawn(deal, txid) {
  return api('/api/safe/escrow/withdrawn', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: deal.id, token: deal.token, txid }) });
}
export async function sendClaim(deal, requested, reason) {
  return api('/api/safe/escrow/dispute/claim', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: deal.id, token: deal.token, requested, reason }) });
}
/** Deliberate chat reveal to the arbiter: send the CHAT key (not the escrow one). The server checks it against the role's chat_pk. */
export async function revealChat(deal) {
  return api('/api/safe/escrow/dispute/reveal', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: deal.id, token: deal.token, chat_sk: deal.chat_sk }) });
}
export async function postMutualSig(deal, sig) {
  return api('/api/safe/escrow/dispute/mutual-sig', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: deal.id, token: deal.token, sig }) });
}
export async function getMutualSigs(deal) {
  return api(`/api/safe/escrow/dispute/mutual-sig?id=${deal.id}&token=${encodeURIComponent(deal.token)}`);
}

/** Parse a claim from /dispute/state — the server stores it as "[требует: X] text" (RU tag is the wire format). */
export function parseClaim(s) {
  const m = /^\[требует:\s*(refund|release|split)\]\s*([\s\S]*)$/.exec(s || '');
  return m ? { req: m[1], reason: m[2].trim() } : { req: null, reason: (s || '').trim() };
}

/** Seconds → "≈ 23 ч 12 мин" / '≈ 23h 12m' (verdict acceptance window). */
export function fmtHM(secs) {
  const ru = lang() === 'ru';
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const U = ru ? { h: 'ч', m: 'мин' } : { h: 'h', m: 'm' };
  return h > 0 ? `≈ ${h} ${U.h} ${m} ${U.m}` : `≈ ${m} ${U.m}`;
}

/**
 * Split shares — mirror of the core's mutual_outputs (spec §4.1): to_seller = amount − to_buyer −
 * fee_resolve − FEE. The formula MUST match on both sides — otherwise the signatures won't agree.
 * → {raw, amount, toBuyer, toSeller, ok}; ok=false — a share below 1 KAS (the split cannot execute).
 */
export async function splitAmounts(deal, pct) {
  const raw = await utxosRaw(deal.disputed_addr);
  const u = JSON.parse(raw).find((x) => x.covenant_id);
  if (!u) throw new Error('disputed utxo not found');
  const total = u.amount - (deal.cfg.fee_resolve || 0) - MUTUAL_FEE;
  const toBuyer = Math.floor(total * pct / 100);
  const toSeller = total - toBuyer;
  return { raw, amount: u.amount, toBuyer, toSeller, ok: total > 0 && toBuyer >= SPLIT_MIN_OUT && toSeller >= SPLIT_MIN_OUT };
}
