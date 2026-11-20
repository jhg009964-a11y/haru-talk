import Anthropic from "@anthropic-ai/sdk";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { TextToSpeech } from "@capacitor-community/text-to-speech";
import { Capacitor, registerPlugin } from "@capacitor/core";
// Haru's own mic module (android/app/.../HaruMicPlugin.java). Older installs don't have it and use the community plugin.
const HaruMic = registerPlugin("HaruMic");

/* ================= data ================= */
const SCENARIOS = [
  { id: "stranger", title: "처음 만난 사람", desc: "모임에서 처음 본 또래", role: "모임에서 오늘 처음 만난 또래. 이름은 하루. 취미는 산책과 요즘 보는 드라마. 반말 OK인 분위기." },
  { id: "friend", title: "오랜만에 친구", desc: "근황 수다", role: "몇 달 만에 연락한 친한 친구 하루. 최근 이사를 했고 새 동네 얘기를 하고 싶어함. 반말." },
  { id: "date", title: "소개팅", desc: "첫 만남 어색함 깨기", role: "소개팅에서 처음 만난 상대 하루. 카페에 마주 앉아 있음. 여행과 맛집을 좋아함. 존댓말." },
  { id: "coworker", title: "회사 동료와 점심", desc: "아직 안 친한 동료", role: "같은 팀이지만 아직 별로 안 친한 동료 하루. 점심 먹으러 같이 나옴. 주말에 등산을 다님. 존댓말." },
  { id: "free", title: "자유 대화", desc: "아무 얘기나", role: "편하게 수다 떠는 친구 하루. 어떤 주제든 좋아함. 반말." },
];
const PERSONA = {
  warm: "리액션을 크게 해 주고, 상대가 말을 잘 못 이어가면 부드럽게 질문을 던져 도와준다.",
  normal: "보통 사람처럼 자연스럽게 반응한다. 지나치게 돕지도, 무뚝뚝하지도 않다.",
  shy: "말수가 적고 짧게 대답한다. 상대가 질문하고 이끌어 주어야 조금씩 말이 길어진다. 스스로 질문은 가끔만 한다.",
};

const $ = (id) => document.getElementById(id);
const show = (id) => ["home", "call", "reportScreen", "settings"].forEach((s) => ($(s).hidden = s !== id));

/* ================= settings ================= */
const S = Object.assign(
  { apiKey: "", model: "claude-opus-5-5", voice: -1, rate: 1, pitch: 1, engine: "phone", elKey: "", elVoice: "", elVoiceName: "", elModel: "eleven_multilingual_v2", provider: "gemini", gemKey: "", gemModel: "" },
  JSON.parse(localStorage.getItem("haru.settings") || "{}")
);
const saveS = () => localStorage.setItem("haru.settings", JSON.stringify(S));
// v2: the first build defaulted to the lower-quality Flash model — move saved settings to Multilingual v2 once.
if (!S.v2) { if (S.elModel === "eleven_flash_v2_5") S.elModel = "eleven_multilingual_v2"; S.v2 = true; saveS(); }
let koVoices = []; // {index, name}

async function loadVoices() {
  const sel = $("voiceSel");
  sel.textContent = "";
  sel.add(new Option("기본 목소리 (휴대폰 기본 TTS)", "-1"));
  try {
    const { voices } = await TextToSpeech.getSupportedVoices();
    koVoices = voices
      .map((v, i) => ({ ...v, index: i }))
      .filter((v) => /^ko/i.test(v.lang));
    koVoices.forEach((v) => {
      const net = v.localService === false ? " · 온라인(더 자연스러움)" : "";
      sel.add(new Option(`${v.name}${net}`, String(v.index)));
    });
  } catch (e) {}
  sel.value = String(S.voice);
  if (sel.value === "") sel.value = "-1";
}

function fillSettings() {
  $("apiKey").value = S.apiKey;
  $("modelSel").value = S.model;
  $("rate").value = S.rate; $("rateVal").textContent = Number(S.rate).toFixed(2);
  $("pitch").value = S.pitch; $("pitchVal").textContent = Number(S.pitch).toFixed(2);
  $("autoMic").checked = S.autoMic === true;
  $("providerSel").value = S.provider; $("gemKey").value = S.gemKey;
  if (S.gemModel && ![...$("gemModel").options].some((o) => o.value === S.gemModel)) $("gemModel").add(new Option(S.gemModel, S.gemModel));
  $("gemModel").value = S.gemModel; toggleProvider();
  $("engineSel").value = S.engine; $("elKey").value = S.elKey; $("elModel").value = S.elModel;
  const sel = $("elVoice");
  if (S.elVoice && ![...sel.options].some((o) => o.value === S.elVoice)) sel.add(new Option(S.elVoiceName || S.elVoice, S.elVoice));
  sel.value = S.elVoice;
  toggleEngine();
  loadVoices();
}
function toggleEngine() {
  const el = $("engineSel").value === "eleven";
  $("elevenBox").hidden = !el; $("phoneVoiceField").hidden = el; $("installVoice").hidden = el;
}
$("engineSel").onchange = toggleEngine;
function toggleProvider() { const g = $("providerSel").value === "gemini"; $("geminiBox").hidden = !g; $("claudeBox").hidden = g; }
$("providerSel").onchange = toggleProvider;
// Lists the chat models this key can use, best pick for a live conversation first.
// Measured 2026-11-21 with a new key: flash-lite models answer in ~1–2 s, full flash models took 20–100 s
// or returned 503 (overloaded), and gemini-2.5-* answer 404 "no longer available to new users".
async function listGemModels(key) {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": key } });
  if (!r.ok) throw new Error(r.status === 400 || r.status === 403 ? "API 키가 맞지 않아요." : `오류 ${r.status}`);
  const { models = [] } = await r.json();
  const ok = models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && /^models\/gemini-/.test(m.name)
      && !/embedding|image|tts|audio|live|vision|aqa|robotics|computer-use|transcribe|omni|banana|customtools/.test(m.name))
    .map((m) => m.name.replace(/^models\//, ""));
  const rank = (n) => {
    const v = parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || "0"); // "-latest" aliases → 0, after numbered ones
    return (/lite/.test(n) ? 0 : 100) + (/preview|exp/.test(n) ? 50 : 0) + (/flash/.test(n) ? 0 : 1000) - v * 10;
  };
  return ok.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
let gemList = null; // per app session
async function gemCandidates() {
  if (!gemList) gemList = await listGemModels(S.gemKey);
  const bad = S.gemBad || [];
  const rest = gemList.filter((m) => m !== S.gemModel && !bad.includes(m));
  return (bad.includes(S.gemModel) || !gemList.includes(S.gemModel) ? [] : [S.gemModel]).concat(rest);
}
$("gemLoad").onclick = async () => {
  const key = $("gemKey").value.trim();
  if (!key) { $("gemMsg").textContent = "API 키를 먼저 넣어 주세요."; return; }
  $("gemMsg").textContent = "불러오는 중…";
  try {
    const ok = await listGemModels(key);
    const sel = $("gemModel"), keep = sel.value; sel.textContent = "";
    const usable = ok.filter((m) => !(S.gemBad || []).includes(m));
    usable.forEach((n, i) => sel.add(new Option(n + (i === 0 ? " (추천)" : ""), n)));
    sel.value = usable.includes(keep) ? keep : usable[0];
    $("gemMsg").textContent = `${usable.length}개 모델을 불러왔어요. 대화에는 flash-lite 모델이 가장 빨라요. 고른 모델이 안 되면 앱이 알아서 다른 모델로 바꿔요.`;
  } catch (e) { $("gemMsg").textContent = "불러오지 못했어요. " + (e.message || "인터넷 연결을 확인해 주세요."); }
};
$("elLoad").onclick = async () => {
  const key = $("elKey").value.trim();
  if (!key) { $("elMsg").textContent = "API 키를 먼저 넣어 주세요."; return; }
  $("elMsg").textContent = "불러오는 중…";
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
    if (!r.ok) throw new Error(r.status === 401 ? "API 키가 맞지 않아요." : `오류 ${r.status}`);
    const { voices } = await r.json();
    const sel = $("elVoice"); sel.textContent = "";
    // the user's own (cloned / generated) voices first
    voices.sort((a, b) => (a.category === "premade") - (b.category === "premade"));
    voices.forEach((v) => sel.add(new Option(`${v.name}${v.category === "premade" ? "" : " · 내 목소리"}`, v.voice_id)));
    if (S.elVoice) sel.value = S.elVoice;
    $("elMsg").textContent = `${voices.length}개의 목소리를 불러왔어요.`;
  } catch (e) { $("elMsg").textContent = "불러오지 못했어요. " + (e.message || "인터넷 연결을 확인해 주세요."); }
};
$("rate").oninput = (e) => ($("rateVal").textContent = Number(e.target.value).toFixed(2));
$("pitch").oninput = (e) => ($("pitchVal").textContent = Number(e.target.value).toFixed(2));
function readSettings() {
  S.apiKey = $("apiKey").value.trim();
  S.model = $("modelSel").value;
  S.voice = Number($("voiceSel").value);
  S.rate = Number($("rate").value);
  S.pitch = Number($("pitch").value);
  S.autoMic = $("autoMic").checked;
  S.provider = $("providerSel").value;
  S.gemKey = $("gemKey").value.trim();
  S.gemModel = $("gemModel").value;
  gemList = null;
  S.engine = $("engineSel").value;
  S.elKey = $("elKey").value.trim();
  S.elVoice = $("elVoice").value;
  S.elVoiceName = $("elVoice").selectedOptions[0]?.textContent || "";
  S.elModel = $("elModel").value;
}
$("openSettings").onclick = () => { fillSettings(); show("settings"); };
$("closeSettings").onclick = () => show("home");
$("saveSettings").onclick = () => {
  readSettings(); saveS(); show("home");
};
$("previewVoice").onclick = () => { readSettings(); speak("안녕! 나 하루야. 음, 이 목소리 어때? 괜찮아?"); };
$("installVoice").onclick = () => TextToSpeech.openInstall().catch(() => alert("이 휴대폰에서는 음성 데이터 설치 화면을 열 수 없어요. 설정 → 텍스트 음성 변환에서 받아 주세요."));

/* ================= home ================= */
let scenario = SCENARIOS[0];
SCENARIOS.forEach((s, i) => {
  const b = document.createElement("button");
  b.setAttribute("aria-pressed", i === 0 ? "true" : "false");
  b.append(Object.assign(document.createElement("b"), { textContent: s.title }), Object.assign(document.createElement("span"), { textContent: s.desc }));
  b.onclick = () => { scenario = s; [...$("scenList").children].forEach((c) => c.setAttribute("aria-pressed", c === b ? "true" : "false")); };
  $("scenList").append(b);
});

function past() { try { return JSON.parse(localStorage.getItem("haru.past") || "[]"); } catch { return []; } }
function renderPast() {
  const box = $("pastList"); box.textContent = "";
  const list = past();
  if (!list.length) { box.append(Object.assign(document.createElement("div"), { className: "empty", textContent: "아직 기록이 없어요. 첫 통화를 해 볼까요?" })); return; }
  list.forEach((p) => {
    const b = document.createElement("button");
    const sc = p.data?.scores ? ` · 리액션 ${p.data.scores.reaction} 질문 ${p.data.scores.question} 내얘기 ${p.data.scores.story}` : "";
    b.append(Object.assign(document.createElement("span"), { textContent: p.title }), Object.assign(document.createElement("small"), { textContent: p.date + sc }));
    b.onclick = () => { renderReport(p.data, p.transcript); show("reportScreen"); };
    box.append(b);
  });
}
renderPast();

/* ================= Claude ================= */
const client = () => new Anthropic({ apiKey: S.apiKey, dangerouslyAllowBrowser: true });
// Server-side fallback on refusals is available for Opus 5.5, not for Haiku 5.5.
const fallbackOpts = () => (S.model === "claude-opus-5-5" ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {});

/* ---- Gemini (REST) ---- */
const usingGemini = () => S.provider === "gemini";
const haveKey = () => (usingGemini() ? !!S.gemKey : !!S.apiKey);
class GeminiError extends Error { constructor(status, detail) { super(detail || "gemini " + status); this.status = status; } }
// One request to one model, with a time limit.
async function geminiOnce(model, body, timeoutMs, outer) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  outer?.addEventListener("abort", () => ctl.abort());
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", signal: ctl.signal,
      headers: { "x-goog-api-key": S.gemKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let detail = ""; try { detail = (await r.json()).error?.message || ""; } catch {}
      throw new GeminiError(r.status, detail);
    }
    const j = await r.json();
    const c = j.candidates?.[0];
    if (!c?.content?.parts) throw new GeminiError("blocked", j.promptFeedback?.blockReason || c?.finishReason);
    return c.content.parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
  } catch (e) {
    if (e.name === "AbortError") throw new GeminiError("timeout", "timeout");
    throw e;
  } finally { clearTimeout(timer); }
}
// Free-tier requests sometimes sit in a queue: the same request took 0.7 s once and 17 s the next time.
// Sending extra requests early made it worse (it uses up the per-minute limit), so a second model is only
// tried after `hedgeMs`; the first answer wins and the others are cancelled.
// A model closed to this key (404, or a zero free quota) is remembered and never tried again; a busy one
// (503, 429, 500, timeout) is only skipped this time. The model that answers becomes the saved one.
async function gemini(body, timeoutMs = 20000, hedgeMs = 12000) {
  const queue = (await gemCandidates()).slice(0, 5);
  if (!queue.length) throw new GeminiError(404, "no models");
  const stopAll = new AbortController();
  return new Promise((resolve, reject) => {
    let running = 0, done = false, last = null, hedgeTimer = 0;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(hedgeTimer); stopAll.abort(); fn(v); };
    const launch = () => {
      if (done) return;
      clearTimeout(hedgeTimer);
      const m = queue.shift();
      if (!m) { if (!running) finish(reject, last || new GeminiError(404, "no models")); return; }
      running++;
      hedgeTimer = setTimeout(launch, hedgeMs);
      geminiOnce(m, body, timeoutMs, stopAll.signal).then(
        (t) => { if (S.gemModel !== m) { S.gemModel = m; saveS(); } finish(resolve, t); },
        (e) => {
          running--;
          if (done) return;
          if (!(e instanceof GeminiError)) return finish(reject, e); // network down
          last = e;
          const closed = e.status === 404 || (e.status === 429 && /limit: 0|free_tier/i.test(e.message));
          if (closed) { S.gemBad = [...new Set([...(S.gemBad || []), m])]; saveS(); }
          if (closed || e.status === 503 || e.status === 429 || e.status === 500 || e.status === "timeout") launch();
          else finish(reject, e); // bad key, blocked content, malformed request: same for every model
        },
      );
    };
    launch();
  });
}
// Streaming version for the live conversation: text arrives piece by piece (Server-Sent Events).
// If nothing has arrived after `firstMs` the model is treated as busy and the next one is tried.
async function geminiStreamOnce(model, body, onText, firstMs) {
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(), firstMs);
  let acc = "";
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: "POST", signal: ctl.signal,
      headers: { "x-goog-api-key": S.gemKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let detail = ""; try { const j = await r.json(); detail = (Array.isArray(j) ? j[0] : j).error?.message || ""; } catch {}
      throw new GeminiError(r.status, detail);
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        let j; try { j = JSON.parse(line.slice(5)); } catch { continue; }
        if (j.error) throw new GeminiError(j.error.code || 500, j.error.message);
        const t = (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
        if (t) {
          if (!acc) { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), 30000); } // got going: allow time to finish
          acc += t; onText?.(acc);
        }
      }
    }
    if (!acc) throw new GeminiError("blocked", "empty");
    return acc;
  } catch (e) {
    if (acc) return acc; // cut off mid-reply: keep what arrived (it is already on screen and being spoken)
    if (e.name === "AbortError") throw new GeminiError("timeout", "timeout");
    throw e;
  } finally { clearTimeout(timer); }
}
// Tries models one after another (the saved one first) with the same rules as gemini().
async function geminiChat(body, onText) {
  const models = (await gemCandidates()).slice(0, 4);
  let last = null;
  for (const [i, m] of models.entries()) {
    try {
      // free-tier answers come back either in ~1 s or after a long queue — don't sit in the queue, try another model;
      // the last one gets more time so a slow answer still beats no answer
      const t = await geminiStreamOnce(m, body, onText, i < models.length - 1 ? 4500 : 20000);
      if (S.gemModel !== m) { S.gemModel = m; saveS(); }
      return t;
    } catch (e) {
      if (!(e instanceof GeminiError)) throw e;
      last = e;
      const closed = e.status === 404 || (e.status === 429 && /limit: 0|free_tier/i.test(e.message));
      if (closed) { S.gemBad = [...new Set([...(S.gemBad || []), m])]; saveS(); continue; }
      if (e.status === 503 || e.status === 429 || e.status === 500 || e.status === "timeout") continue;
      throw e;
    }
  }
  throw last || new GeminiError(404, "no models");
}
const toGem = (msgs) => msgs.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

/* ---- one interface for both AIs ---- */
async function aiChat(system, messages, onText) {
  if (usingGemini()) {
    return geminiChat({ systemInstruction: { parts: [{ text: system }] }, contents: toGem(messages),
      generationConfig: { temperature: 0.9, maxOutputTokens: 2048 } }, onText);
  }
  const stream = client().beta.messages.stream({ model: S.model, max_tokens: 1024, system, messages, output_config: { effort: "low" }, ...fallbackOpts() });
  let acc = "";
  stream.on("text", (d) => { acc += d; onText?.(acc); });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("refusal");
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}
async function aiText(prompt) {
  if (usingGemini()) return gemini({ contents: toGem([{ role: "user", content: prompt }]), generationConfig: { maxOutputTokens: 2048 } });
  const r = await client().messages.create({ model: S.model, max_tokens: 1024, output_config: { effort: "low" }, messages: [{ role: "user", content: prompt }] });
  return r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}
async function aiJSON(prompt, schema) {
  let text;
  if (usingGemini()) {
    text = await gemini({ contents: toGem([{ role: "user", content: prompt + "\n\n반드시 다음 JSON 스키마에 맞는 JSON 하나만 출력해:\n" + JSON.stringify(schema) }]),
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 16384 } }, 60000, 20000);
  } else {
    const r = await client().beta.messages.create({ model: S.model, max_tokens: 16000,
      output_config: { effort: "medium", format: { type: "json_schema", schema } }, ...fallbackOpts(),
      messages: [{ role: "user", content: prompt }] });
    if (r.stop_reason === "refusal") throw new Error("refusal");
    text = r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
}

function errText(e) {
  if (e instanceof GeminiError) {
    if (e.status === 400 && /api key/i.test(e.message)) return "Gemini API 키가 맞지 않아요. 설정에서 확인해 주세요.";
    if (e.status === 403) return "이 Gemini 키로는 쓸 수 없어요. 키 권한을 확인해 주세요.";
    if (e.status === 404) return "고른 Gemini 모델을 찾을 수 없어요. 설정에서 모델 목록을 다시 불러와 주세요.";
    if (e.status === 429) return "Gemini 무료 사용량을 다 썼어요. 1분쯤 쉬었다가 다시 말해 줘.";
    if (e.status === 503 || e.status === 500 || e.status === "timeout") return "지금 Gemini 서버가 바빠서 대답이 늦어. 조금 있다가 다시 말해 줘.";
    if (e.status === "blocked") return "그 말은 대답하기 어려워. 다른 얘기 해 볼까?";
    return "연결이 잠깐 끊겼어. 다시 말해 줄래?";
  }
  if (e instanceof TypeError) return "인터넷 연결이 불안정해요. 연결을 확인해 주세요.";
  if (e instanceof Anthropic.AuthenticationError) return "API 키가 맞지 않아요. 설정에서 키를 확인해 주세요.";
  if (e instanceof Anthropic.PermissionDeniedError) return "이 API 키로는 사용할 수 없어요. 콘솔에서 결제/권한을 확인해 주세요.";
  if (e instanceof Anthropic.RateLimitError) return "잠깐 숨 좀 돌릴게… 몇 초 뒤에 다시 말해 줘.";
  if (e instanceof Anthropic.APIConnectionError) return "인터넷 연결이 불안정해요. 연결을 확인해 주세요.";
  if (e instanceof Anthropic.APIError && e.status === 400 && /credit/i.test(e.message)) return "API 크레딧이 부족해요. 콘솔에서 충전해 주세요.";
  return "연결이 잠깐 끊겼어. 다시 말해 줄래?";
}

function systemPrompt() {
  return `너는 대화 연습 앱의 영상통화 상대 "하루"야. 사용자는 말주변이 없어서 재미있게 대화하는 법을 연습하고 있어.
상황: ${scenario.role}
성격: ${PERSONA[$("personaSel").value]}
규칙:
- 실제 사람처럼 한국어 구어체로, 1~3문장으로 짧게 말해.
- 상황 속 인물로만 말하고, 연습이나 AI라는 말은 하지 마.
- 이모지, 괄호 속 행동 묘사, 마크다운은 쓰지 마. 소리 내어 읽힐 문장이야.
- 글이 아니라 말처럼 써. "아 진짜?", "음…", "헐", "오~", "그니까" 같은 추임새를 자연스럽게 섞고, 쉼표와 말줄임표로 숨 쉬는 곳을 만들어.
- 숫자는 한글로 읽히게 써 (예: "세 시").
출력 형식 (반드시 지켜):
하루의 대사만 먼저 쓰고, 다음 줄에 정확히 "###팁" 이라고 쓴 뒤, 다음 줄에 사용자의 직전 말에 대한 코치 팁을 한 문장(40자 이내)으로 써. 첫 인사 차례면 대화를 시작하는 요령을 팁으로 줘.`;
}

/* ================= call ================= */
let history = [];   // {role, content} — sent to the API
let tips = [];
let inCall = false, busy = false, startTime = 0, timerId = 0;
let speaking = false, listening = false, thinking = false;
let heard = "";
let camStream = null;

function setState() {
  $("haruState").textContent = thinking ? "생각하는 중…" : speaking ? "말하는 중" : listening ? "듣는 중" : "통화 중";
  $("micBtn").classList.toggle("on", listening);
  $("micBtn").disabled = !inCall || (busy && !listening);
  $("hintBtn").disabled = !inCall || busy || history.length < 2;
}
function tick() {
  const s = Math.floor((Date.now() - startTime) / 1000);
  $("timer").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

$("startCall").onclick = async () => {
  if (!haveKey()) { fillSettings(); show("settings"); alert(usingGemini() ? "먼저 Gemini API 키를 넣어 주세요." : "먼저 Claude API 키를 넣어 주세요."); return; }
  show("call");
  history = [{ role: "user", content: "(통화가 연결됐어. 네가 먼저 상황에 맞게 짧게 인사해.)" }];
  tips = []; heard = ""; elPrev = ""; reopenCount = 0; elWarned = false; errCount = 0;
  if (useEleven()) voiceSettings(); // fetch the voice's settings now, not when the first sentence is waiting $("mine").textContent = ""; $("caption").textContent = "";
  inCall = true; startTime = Date.now(); clearInterval(timerId); timerId = setInterval(tick, 1000); tick();
  setState();
  startCamera();
  try { await SpeechRecognition.requestPermissions(); } catch {}
  haruTurn();
};

async function startCamera() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    $("selfCam").srcObject = camStream; $("selfCam").hidden = false;
  } catch { $("selfCam").hidden = true; }
}
function stopCamera() { camStream?.getTracks().forEach((t) => t.stop()); camStream = null; }
$("camBtn").onclick = () => { if (camStream) { stopCamera(); $("selfCam").hidden = true; } else startCamera(); };

// Haru's reply streams in; each finished sentence is handed to the voice right away,
// so Haru starts talking before the whole reply (and the coach tip) has arrived.
async function haruTurn() {
  busy = true; thinking = true; setState();
  sayReset();
  let queued = 0; // characters of the reply already handed to the voice
  const feed = (acc, final) => {
    const body = acc.split("#")[0]; // stop at the "###팁" marker, even half-streamed
    $("caption").textContent = body.trim() || "…";
    if (thinking && body.trim()) { thinking = false; setState(); }
    let upto = queued;
    const re = /[.!?…]+["'”’)]*\s+|\n+/g; let m;
    while ((m = re.exec(body))) { const end = m.index + m[0].length; if (end > queued && end - queued >= 6) upto = end; }
    if (final) upto = body.length;
    if (upto > queued) { const chunk = body.slice(queued, upto).trim(); queued = upto; if (chunk) sayPush(chunk); }
  };
  let reply = "", tip = "";
  try {
    const text = await aiChat(systemPrompt(), history, (acc) => feed(acc, false));
    feed(text, true);
    const i = text.indexOf("###팁");
    reply = (i < 0 ? text : text.slice(0, i)).replace(/#+\s*$/, "").trim();
    tip = i < 0 ? "" : text.slice(i + 4).trim().split("\n")[0].trim();
  } catch (e) {
    thinking = false; busy = false; setState();
    sayReset();
    $("caption").textContent = errText(e);
    if (history.at(-1)?.role === "user" && history.length > 1) history.pop();
    afterHaru();
    return;
  }
  thinking = false;
  history.push({ role: "assistant", content: reply });
  if (tip) { tips.push(tip); flashTip(tip); }
  $("caption").textContent = reply;
  busy = false; setState();
  await sayDone();
  afterHaru();
}
// After Haru has spoken: open the mic by itself (auto mode) or wait for the tap (tap-to-talk).
function afterHaru() {
  if (!inCall || busy || listening) return;
  if (manual()) $("mine").textContent = "🎤 버튼을 누르고 말하세요";
  else listenSoon();
}

let tipTimer = 0;
function flashTip(t, ms = 6000) {
  $("tipToast").textContent = "💬 " + t; $("tipToast").hidden = false;
  clearTimeout(tipTimer); tipTimer = setTimeout(() => ($("tipToast").hidden = true), ms);
}

/* ---- speech out ---- */
let elAudio = null, elPrev = "", elVoiceSettings = null, elSettingsFor = "";
// Use the voice's own saved settings (what the ElevenLabs website preview uses); only the speed is changed, and only if the user moved the slider.
async function voiceSettings() {
  if (elSettingsFor !== S.elVoice) {
    elVoiceSettings = null; elSettingsFor = S.elVoice;
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(S.elVoice)}/settings`, { headers: { "xi-api-key": S.elKey } });
      if (r.ok) elVoiceSettings = await r.json();
    } catch {}
  }
  if (Math.abs(S.rate - 1) < 0.01) return undefined;
  return elVoiceSettings ? { ...elVoiceSettings, speed: Math.min(1.2, Math.max(0.7, S.rate)) } : undefined;
}
// Spoken-text cleanup: ElevenLabs reads "…" and "~" oddly in Korean.
const tidy = (t) => t.replace(/…+|\.{3,}/g, ", ").replace(/~+/g, "").replace(/\s+,/g, ",").replace(/,\s*,/g, ",").trim();
// Starts generating the audio for one piece of text (called as soon as the sentence exists, so the next
// sentence is already being made while the current one plays). Uses the streaming endpoint: the audio
// arrives in pieces and playback starts with the first piece instead of after the whole sentence.
async function elevenFetch(text) {
  const body = { text: tidy(text), model_id: S.elModel };
  if (S.elModel !== "eleven_v3" && elPrev) body.previous_text = elPrev; // keeps intonation consistent between sentences
  elPrev = body.text;
  const vs = await voiceSettings(); if (vs) body.voice_settings = vs;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(S.elVoice)}/stream?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": S.elKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const msg = r.status === 401 ? "ElevenLabs 키가 맞지 않아요" : r.status === 402 || r.status === 429 ? "ElevenLabs 크레딧/사용량이 부족해요" : `ElevenLabs 오류 ${r.status}`;
    throw new Error(msg);
  }
  return r;
}
// Plays a streaming MP3 response, starting as soon as the first piece has arrived (MediaSource);
// falls back to waiting for the whole file where MediaSource can't play MP3.
async function playResponse(res) {
  const canStream = res.body && window.MediaSource && MediaSource.isTypeSupported("audio/mpeg");
  if (!canStream) return playBlob(await res.blob());
  const ms = new MediaSource(), url = URL.createObjectURL(ms);
  const a = new Audio(url); elAudio = a;
  try {
    const ended = new Promise((ok, fail) => { a.onended = ok; a.onerror = () => fail(new Error("재생 실패")); });
    ended.catch(() => {});
    await new Promise((r) => ms.addEventListener("sourceopen", r, { once: true }));
    const sb = ms.addSourceBuffer("audio/mpeg");
    const reader = res.body.getReader();
    let started = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done || elAudio !== a) { if (elAudio !== a) reader.cancel().catch(() => {}); break; }
      sb.appendBuffer(value);
      await new Promise((r) => sb.addEventListener("updateend", r, { once: true }));
      if (!started) { started = true; a.play().catch(() => {}); }
    }
    if (ms.readyState === "open") ms.endOfStream();
    if (!started) a.play().catch(() => {}); // very short clip that arrived in one piece
    await ended;
  } finally { URL.revokeObjectURL(url); if (elAudio === a) elAudio = null; }
}
async function playBlob(blob) {
  const url = URL.createObjectURL(blob);
  try {
    elAudio = new Audio(url);
    await new Promise((res, rej) => { elAudio.onended = res; elAudio.onerror = rej; elAudio.play().catch(rej); });
  } finally { URL.revokeObjectURL(url); elAudio = null; }
}
const voiceOut = { phone: null }; // test hook: replaced by a fake voice when testing on a PC
async function phoneSay(text) {
  if (voiceOut.phone) return voiceOut.phone(text);
  try {
    const opt = { text, lang: "ko-KR", rate: S.rate, pitch: S.pitch, volume: 1, category: "playback" };
    if (S.voice >= 0) opt.voice = S.voice;
    await TextToSpeech.speak(opt);
  } catch {
    await new Promise((r) => setTimeout(r, Math.min(8000, text.length * 110)));
  }
}
function stopSpeaking() {
  TextToSpeech.stop().catch(() => {});
  if (elAudio) { const a = elAudio; elAudio = null; a.pause(); a.onended?.(); }
}

/* A queue of things for Haru to say, played in order. sayReset() cuts it off (new turn, user interrupts). */
const useEleven = () => S.engine === "eleven" && S.elKey && S.elVoice;
let sayQ = [], sayRunning = null, sayGen = 0, elWarned = false;
function sayReset() { sayGen++; sayQ = []; stopSpeaking(); speaking = false; setState(); }
function sayPush(text) {
  const item = { text, audio: useEleven() ? elevenFetch(text) : null };
  item.audio?.catch(() => {}); // handled when played
  sayQ.push(item);
  if (!sayRunning || sayRunning.gen !== sayGen) sayRunning = { gen: sayGen, p: sayLoop(sayGen) };
}
async function sayLoop(gen) {
  speaking = true; setState();
  while (sayQ.length && gen === sayGen) {
    const it = sayQ.shift();
    if (it.audio) {
      try {
        await playResponse(await it.audio);
        if (!$("settings").hidden) $("elMsg").textContent = "✓ ElevenLabs 목소리로 재생했어요.";
        continue;
      } catch (e) {
        if (gen !== sayGen) break;
        const m = (e.message || "ElevenLabs 연결 실패") + " · 휴대폰 목소리로 대신 말했어요";
        if (!elWarned) { flashTip(m); elWarned = true; }
        if (!$("settings").hidden) $("elMsg").textContent = "⚠ " + m;
      }
    }
    if (gen === sayGen) await phoneSay(it.text);
  }
  if (gen === sayGen) { speaking = false; setState(); }
  if (sayRunning?.gen === gen) sayRunning = null;
}
async function sayDone() { while (sayRunning && sayRunning.gen === sayGen) await sayRunning.p; }
async function speak(text) { sayReset(); elWarned = false; sayPush(text); await sayDone(); }

/* ---- speech in ---- */
// How the Android recognizer behaves (from the plugin's source):
// - "started" only fires when the person begins to speak, not when the mic opens.
// - "stopped" fires at end of speech, *before* the final words arrive.
// - If nobody speaks for a few seconds (or it hears nothing it can match) it shuts down with an error
//   that never reaches the page — so the page must notice on its own and reopen the mic.
// - In dictation mode (live text on) it waits a long time after the person stops talking.
// So the page keeps its own state: it decides the turn is over after a short silence in the live text,
// and reopens the mic if nothing at all has arrived for a while.
const mic = {
  native: Capacitor.isPluginAvailable("HaruMic"), // new installs: Haru's own module, which reports every stage
  start: (o) => (mic.native ? HaruMic.start(o) : SpeechRecognition.start(o)),
  stop: () => (mic.native ? HaruMic.cancel() : SpeechRecognition.stop()),
};
const SILENCE_MS = 1300;  // no new words for this long → the person has finished
const NO_SPEECH_MS = 8000; // nothing heard at all → the recognizer has probably shut down; reopen it
const MAX_REOPEN = 6;      // quiet reopenings (~50 s of silence) before waiting for a tap
let micSession = 0, silenceT = 0, watchdogT = 0, reopenCount = 0, listenSoonT = 0;

/* Tap-to-talk (the default): the person taps 🎤 to start and taps again when finished. The phone's recognizer
   still stops by itself at every pause, so in this mode each piece it hears is kept and the recognizer is
   restarted at once, until the second tap sends everything. */
const manual = () => S.autoMic !== true;
let kept = "", finishing = false, finishT = 0;
const join = (a, b) => [a, b].map((x) => (x || "").trim()).filter(Boolean).join(" ");
function showMine() { $("mine").textContent = join(kept, heard) || "🎤 듣는 중… 다 말하면 🎤를 다시 누르세요"; }
async function restartMic() {
  if (!listening || finishing) return;
  const my = ++micSession;
  clearTimeout(watchdogT);
  watchdogT = setTimeout(() => { if (listening && micSession === my) restartMic(); }, mic.native ? 4000 : NO_SPEECH_MS);
  try {
    await (mic.native ? mic.start({ language: "ko-KR", silenceMs: 10000, continuous: true })
      : mic.start({ language: "ko-KR", partialResults: true, popup: false, maxResults: 1 }));
  } catch {
    setTimeout(() => { if (listening && micSession === my) restartMic(); }, 500);
  }
}
function finishManual() {
  if (finishing || !listening) return;
  finishing = true;
  $("micBtn").disabled = true;
  if (mic.native) HaruMic.stop().catch(() => {}); // ask for the last words as a "final" event
  finishT = setTimeout(completeFinish, mic.native ? 700 : 400);
}
function completeFinish() {
  if (!finishing) return;
  clearTimeout(finishT);
  const t = join(kept, heard); kept = ""; heard = "";
  stopMic();
  if (t && inCall && !busy) userSays(t);
  else $("mine").textContent = "🎤 버튼을 누르고 말하세요";
}

function onPartial(d) {
  if (!listening) return;
  const t = d.matches?.[0];
  if (!t || t === heard) return;
  if (manual()) { heard = t; showMine(); clearTimeout(watchdogT); return; }
  heard = t; $("mine").textContent = heard;
  clearTimeout(watchdogT);
  clearTimeout(silenceT); silenceT = setTimeout(endTurn, speechEnded ? 300 : SILENCE_MS);
}
let speechEnded = false;
function onListeningState(d) {
  if (!listening) return;
  if (manual()) {
    // the recognizer paused by itself: keep what it heard (final words may still arrive) and carry on listening
    if (d.status === "stopped") setTimeout(() => { if (!listening || finishing) return; kept = join(kept, heard); heard = ""; showMine(); restartMic(); }, 400);
    return;
  }
  if (d.status === "started") speechEnded = false;
  if (d.status === "stopped") {
    speechEnded = true;
    // end of speech: the final words may still be on their way — give them a moment
    clearTimeout(silenceT); silenceT = setTimeout(endTurn, heard.trim() ? 500 : 300);
  }
}
SpeechRecognition.addListener("partialResults", (d) => { if (!mic.native) onPartial(d); });
SpeechRecognition.addListener("listeningState", (d) => { if (!mic.native) onListeningState(d); });

// Haru's own module tells us exactly what happens, so no guessing is needed:
// ready → the mic can hear now; partial → live words; final → the turn is over; error → reopen right away.
let errCount = 0;
function onMicEvent(e) {
  if (!listening || !mic.native) return;
  if (manual()) {
    switch (e.type) {
      // the mic is working again: forget earlier hiccups (they used to add up over a long talk and switch it off)
      case "ready": case "begin": clearTimeout(watchdogT); errCount = 0; showMine(); break;
      case "partial":
        if (!e.text) break;
        // in dictation mode some phones restart the live text after a pause: keep the earlier part
        if (heard.length >= 4 && e.text.length < heard.length && !e.text.startsWith(heard.slice(0, 2))) kept = join(kept, heard);
        heard = e.text; errCount = 0; showMine();
        break;
      case "final":
        kept = join(kept, e.text || heard); heard = ""; errCount = 0;
        if (finishing) completeFinish(); else { showMine(); restartMic(); }
        break;
      case "error":
        if (heard) { kept = join(kept, heard); heard = ""; }
        if (finishing) { completeFinish(); break; }
        if (e.code === 9) { stopMic(); $("mine").textContent = "마이크 권한이 필요해요. 휴대폰 설정 → 앱 → 하루 → 권한에서 마이크를 허용해 주세요."; break; }
        // 9 failures in a row without the mic ever working
        if (e.code !== 6 && e.code !== 7 && ++errCount > 8) { stopMic(); $("mine").textContent = "마이크가 잘 안 켜져요. 🎤 버튼을 다시 눌러 주세요."; break; }
        showMine(); restartMic(); // a pause or a hiccup: keep listening
        break;
    }
    return;
  }
  switch (e.type) {
    case "ready":
      clearTimeout(watchdogT);
      $("mine").textContent = "🎤 지금 말하세요";
      // Android ends a silent turn itself (error 6/7) after ~5–8 s; this is only a safety net
      watchdogT = setTimeout(() => { if (listening && !heard) { stopMic(); reopen(); } }, 12000);
      break;
    case "begin":
      clearTimeout(watchdogT); speechEnded = false;
      break;
    case "partial":
      if (!e.text || e.text === heard) break;
      heard = e.text; $("mine").textContent = heard;
      clearTimeout(silenceT); silenceT = setTimeout(endTurn, speechEnded ? 400 : 2000); // backup if "final" is late
      break;
    case "end":
      speechEnded = true;
      clearTimeout(silenceT); silenceT = setTimeout(endTurn, 800);
      break;
    case "final":
      if (e.text) heard = e.text;
      errCount = 0;
      endTurn();
      break;
    case "error":
      if (heard.trim()) { endTurn(); break; }
      stopMic();
      if (e.code === 9) { $("mine").textContent = "마이크 권한이 필요해요. 휴대폰 설정 → 앱 → 하루 → 권한에서 마이크를 허용해 주세요."; break; }
      if (e.code === 6 || e.code === 7) reopen(); // nobody spoke / nothing recognisable: counts toward the quiet limit
      else if (errCount++ < 5) listenSoon(300); // recognizer hiccup: reopen at once
      else $("mine").textContent = "마이크가 잘 안 켜져요. 🎤 버튼을 눌러 주세요.";
      break;
  }
}
if (mic.native) HaruMic.addListener("mic", onMicEvent);

function stopMic() {
  if (!listening) return;
  listening = false; micSession++; finishing = false;
  clearTimeout(silenceT); clearTimeout(watchdogT); clearTimeout(finishT);
  mic.stop().catch(() => {});
  setState();
}
function endTurn() {
  if (!listening) return;
  const t = heard.trim(); heard = "";
  stopMic();
  if (t && inCall && !busy) { reopenCount = 0; userSays(t); }
  else reopen();
}
function reopen() {
  if (!inCall || busy || speaking) return;
  if (reopenCount++ < MAX_REOPEN) listenSoon(250);
  else $("mine").textContent = "🎤 버튼을 누르고 말해 주세요";
}
function listenSoon(ms = 120) { clearTimeout(listenSoonT); listenSoonT = setTimeout(() => listen(), ms); }

async function listen(fromTap = false) {
  if (!inCall || listening || busy) return;
  if (fromTap) reopenCount = 0;
  sayReset(); // never listen while Haru is talking (the mic would hear her)
  if (fromTap) errCount = 0;
  listening = true; heard = ""; kept = ""; finishing = false; speechEnded = false; const my = ++micSession;
  $("mine").textContent = mic.native ? "마이크 켜는 중…" : manual() ? "🎤 듣는 중… 다 말하면 🎤를 다시 누르세요" : "듣고 있어요… 말해 보세요";
  setState();
  clearTimeout(watchdogT);
  // legacy plugin: no error reports, so reopen after a quiet spell; new module: reopen if it never says "ready"
  watchdogT = setTimeout(() => {
    if (!listening || micSession !== my || heard) return;
    if (manual()) restartMic(); else { stopMic(); reopen(); }
  }, mic.native ? 4000 : NO_SPEECH_MS);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // (the legacy plugin's stop() never answers, so never await it)
      await (mic.native
        ? mic.start(manual() ? { language: "ko-KR", silenceMs: 10000, continuous: true } : { language: "ko-KR", silenceMs: 900 })
        : mic.start({ language: "ko-KR", partialResults: true, popup: false, maxResults: 1 }));
      return;
    } catch (e) {
      if (micSession !== my) return; // stopped meanwhile
      if (/permission/i.test(String(e?.message || e))) { listening = false; clearTimeout(watchdogT); setState(); $("mine").textContent = "마이크 권한을 허용해 주세요."; return; }
      if (attempt === 0) { mic.stop().catch(() => {}); await new Promise((r) => setTimeout(r, 400)); continue; } // recognizer still busy from last time
      listening = false; clearTimeout(watchdogT); setState();
      $("mine").textContent = "마이크를 쓸 수 없어요. 아래에 글로 입력해 주세요.";
    }
  }
}
$("micBtn").onclick = () => {
  if (listening) { if (manual()) finishManual(); else endTurn(); }
  else listen(true);
};
$("typeForm").onsubmit = (e) => {
  e.preventDefault();
  const t = $("typeInput").value.trim(); if (!t || busy || !inCall) return;
  $("typeInput").value = ""; heard = ""; kept = "";
  stopMic();
  userSays(t);
};
function userSays(t) { clearTimeout(listenSoonT); $("mine").textContent = t; history.push({ role: "user", content: t }); haruTurn(); }
if (import.meta.env.DEV) window.__haru = { mic, voiceOut, onPartial, onListeningState, onMicEvent, state: () => ({ listening, speaking, busy, thinking, heard, reopenCount }) };

$("hintBtn").onclick = async () => {
  if (busy) return;
  $("hintBtn").disabled = true;
  try {
    const out = await aiText(`대화 연습 중인 사용자가 다음에 할 말을 모르겠대. 아래 대화에 이어서 사용자가 자연스럽고 재밌게 말할 수 있는 한국어 예시 3개를 각각 한 줄로, 번호 없이 써줘. 하나는 공감 리액션, 하나는 질문, 하나는 내 이야기 꺼내기. 예시 문장만 써.\n상황: ${scenario.role}\n${transcript()}`);
    const lines = out.split("\n").map((s) => s.replace(/^[-•*\d.\s]+/, "").trim()).filter(Boolean).slice(0, 3);
    flashTip("이렇게 말해 볼까? " + lines.map((l) => `“${l}”`).join("  /  "), 15000);
  } catch (e) { flashTip(errText(e)); }
  setState();
};

function transcript() {
  return history.slice(1).map((m) => (m.role === "user" ? "사용자: " : "하루: ") + m.content).join("\n");
}

/* ================= end + report ================= */
const REPORT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["turns", "jokes", "scores", "strengths", "mission", "cheer"],
  properties: {
    turns: { type: "array", items: { type: "object", additionalProperties: false, required: ["said", "situation", "good", "better", "why"],
      properties: { said: { type: "string" }, situation: { type: "string" }, good: { type: "boolean" }, better: { type: "string" }, why: { type: "string" } } } },
    jokes: { type: "array", items: { type: "object", additionalProperties: false, required: ["when", "line", "tip"],
      properties: { when: { type: "string" }, line: { type: "string" }, tip: { type: "string" } } } },
    scores: { type: "object", additionalProperties: false, required: ["reaction", "question", "story"],
      properties: { reaction: { type: "integer" }, question: { type: "integer" }, story: { type: "integer" } } },
    strengths: { type: "array", items: { type: "string" } },
    mission: { type: "string" },
    cheer: { type: "string" },
  },
};

$("endBtn").onclick = async () => {
  inCall = false; clearInterval(timerId); clearTimeout(listenSoonT);
  stopMic(); sayReset();
  stopCamera(); listening = speaking = false;
  const userTurns = history.filter((m, i) => i > 0 && m.role === "user").length;
  show("reportScreen");
  if (!userTurns) { $("report").innerHTML = '<div class="loading">이번엔 한 마디도 안 했네요. 다음엔 인사 한 마디부터 해 봐요!</div>'; return; }
  $("report").innerHTML = '<div class="loading">내가 한 말을 하나씩 돌아보고 있어요… (10~30초)</div>';
  const tr = transcript(), duration = $("timer").textContent;
  try {
    const data = await aiJSON(`너는 다정하지만 솔직한 대화 코치야. 말주변이 없다고 느끼는 사용자가 아래 상황에서 영상통화로 대화 연습을 했어.
상황: ${scenario.title} - ${scenario.role}
대화 시간: ${duration}

${tr}

작성 기준 (모두 한국어, 마크다운 없이):
- turns: 사용자의 발언마다 하나씩 순서대로. said=사용자가 한 말 그대로, situation=그때 상황 한 줄(예: 하루가 주말 얘기를 꺼냈을 때), good=이미 충분히 좋았으면 true, better=그 상황에서 더 재밌고 자연스럽게 말하는 예시 문장, why=왜 더 좋은지 한 문장.
- jokes: 이 대화 흐름에서 실제로 써먹을 수 있는 가벼운 농담이나 재치 있는 말 3개. when=어떤 순간에, line=농담 문장, tip=말할 때 요령. 상대를 깎아내리지 않는 살짝 자기 비하, 과장, 공감형 유머 위주로.
- scores: 리액션/질문하기/내 이야기 꺼내기 각각 1~5.
- strengths: 잘한 점 2가지, 구체적으로 발언을 인용해서.
- mission: 다음 연습 미션 한 가지.
- cheer: 응원 한 줄.`, REPORT_SCHEMA);
    renderReport(data, tr);
    const list = past();
    const d = new Date();
    list.unshift({ title: scenario.title, date: `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} · ${duration}`, data, transcript: tr });
    localStorage.setItem("haru.past", JSON.stringify(list.slice(0, 30)));
    renderPast();
  } catch (e) {
    $("report").innerHTML = "";
    $("report").append(Object.assign(document.createElement("div"), { className: "loading", textContent: "정리를 만들지 못했어요. " + errText(e) }));
  }
};
$("closeReport").onclick = () => show("home");

function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function renderReport(d, tr) {
  const box = $("report"); box.textContent = "";
  const sec = (t) => { const s = el("section"); s.append(el("h3", null, t)); box.append(s); return s; };
  if (d.scores) {
    const g = el("div", "scores");
    [["reaction", "리액션"], ["question", "질문하기"], ["story", "내 이야기"]].forEach(([k, l]) => { const c = el("div"); c.append(el("strong", null, `${d.scores[k] ?? "-"} / 5`), l); g.append(c); });
    sec("점수").append(g);
  }
  if (d.turns?.length) {
    const s = sec("내가 한 말, 이렇게 바꿔 보면");
    d.turns.forEach((t) => {
      const c = el("div", "card" + (t.good ? " good" : ""));
      c.append(el("div", "lbl", t.situation), el("div", "lbl", "내가 한 말"), el("div", null, t.said));
      c.append(el("div", "lbl", t.good ? "이미 좋았어요! 이렇게도 가능해요" : "이렇게 말하면"), el("div", "better", t.better), el("div", "why", t.why));
      s.append(c);
    });
  }
  if (d.jokes?.length) {
    const s = sec("써먹을 수 있는 농담");
    d.jokes.forEach((j) => { const c = el("div", "card"); c.append(el("div", "lbl", j.when), el("div", "better", j.line), el("div", "why", j.tip)); s.append(c); });
  }
  if (d.strengths?.length) { const s = sec("잘한 점"); d.strengths.forEach((x) => s.append(el("div", "card", x))); }
  if (d.mission) sec("다음 미션").append(el("div", "card", d.mission));
  if (d.cheer) box.append(el("div", "why", d.cheer));
  if (tr) { const s = sec("대화 전체 기록"); s.append(Object.assign(el("div", "card why"), { style: "white-space:pre-wrap" , textContent: tr })); }
}

/* ================= face ================= */
const cv = $("face"), g = cv.getContext("2d");
let blink = 0, nextBlink = 2500, mouth = 0, lookX = 0, lookTarget = 0, nextLook = 0;
function draw(t) {
  requestAnimationFrame(draw);
  if ($("call").hidden) return;
  const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2 + 30;
  g.clearRect(0, 0, W, H);
  const bob = Math.sin(t / 900) * 4 + (listening ? Math.sin(t / 260) * 3 : 0);
  const target = speaking ? 0.35 + 0.65 * Math.abs(Math.sin(t / 95) * Math.sin(t / 37)) : 0;
  mouth += (target - mouth) * 0.35;
  if (t > nextBlink) { blink = 1; nextBlink = t + 2200 + Math.random() * 3000; }
  blink = Math.max(0, blink - 0.12);
  const eyeOpen = 1 - Math.sin(Math.min(1, blink) * Math.PI);
  if (t > nextLook) { lookTarget = thinking ? 10 : (Math.random() - 0.5) * 10; nextLook = t + 1500 + Math.random() * 2500; }
  lookX += (lookTarget - lookX) * 0.05;
  const y = cy + bob;
  g.fillStyle = "#3d5a8a"; g.beginPath(); g.ellipse(cx, H + 40, 210, 160, 0, Math.PI, 0); g.fill();
  g.fillStyle = "#f2c9a8"; g.fillRect(cx - 30, y + 120, 60, 70);
  g.fillStyle = "#3a2a2f"; g.beginPath(); g.ellipse(cx, y - 10, 160, 175, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#f7d6bb"; g.beginPath(); g.ellipse(cx, y + 10, 130, 150, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#3a2a2f"; g.beginPath(); g.moveTo(cx - 140, y - 20);
  g.quadraticCurveTo(cx - 118, y - 160, cx, y - 158); g.quadraticCurveTo(cx + 123, y - 160, cx + 142, y - 15);
  g.quadraticCurveTo(cx + 64, y - 100, cx + 5, y - 75); g.quadraticCurveTo(cx - 64, y - 106, cx - 140, y - 20); g.fill();
  g.fillStyle = "rgba(255,140,130,.35)";
  g.beginPath(); g.ellipse(cx - 75, y + 55, 26, 15, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(cx + 75, y + 55, 26, 15, 0, 0, Math.PI * 2); g.fill();
  [-1, 1].forEach((s) => {
    const ex = cx + s * 52 + lookX, ey = y + 8 - (thinking ? 6 : 0);
    g.fillStyle = "#2a1f24"; g.beginPath(); g.ellipse(ex, ey, 14, Math.max(1.5, 18 * eyeOpen), 0, 0, Math.PI * 2); g.fill();
    if (eyeOpen > 0.4) { g.fillStyle = "#fff"; g.beginPath(); g.arc(ex + 4, ey - 6 * eyeOpen, 4.5, 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = "#3a2a2f"; g.lineWidth = 5; g.lineCap = "round";
    const lift = listening ? 6 : 0;
    g.beginPath(); g.moveTo(cx + s * 32 + lookX * 0.5, y - 28 - lift);
    g.quadraticCurveTo(cx + s * 52 + lookX * 0.5, y - 37 - lift, cx + s * 72 + lookX * 0.5, y - 30 - lift); g.stroke();
  });
  const my = y + 84, mw = 36;
  if (mouth > 0.05) {
    g.fillStyle = "#8a3b45"; g.beginPath(); g.ellipse(cx, my, mw * (0.75 + 0.25 * mouth), 4 + 22 * mouth, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#e9707e"; g.beginPath(); g.ellipse(cx, my + 8 * mouth, mw * 0.45, 6 * mouth, 0, 0, Math.PI * 2); g.fill();
  } else {
    g.strokeStyle = "#8a3b45"; g.lineWidth = 5; g.lineCap = "round";
    g.beginPath(); g.moveTo(cx - mw, my - 4); g.quadraticCurveTo(cx, my + (thinking ? 6 : 16), cx + mw, my - 4); g.stroke();
  }
}
requestAnimationFrame(draw);
