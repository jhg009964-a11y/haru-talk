import Anthropic from "@anthropic-ai/sdk";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { TextToSpeech } from "@capacitor-community/text-to-speech";

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
  { apiKey: "", model: "claude-opus-5-5", voice: -1, rate: 1, pitch: 1, engine: "phone", elKey: "", elVoice: "", elVoiceName: "", elModel: "eleven_multilingual_v2", provider: "gemini", gemKey: "", gemModel: "gemini-2.5-flash" },
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
  $("providerSel").value = S.provider; $("gemKey").value = S.gemKey;
  if (![...$("gemModel").options].some((o) => o.value === S.gemModel)) $("gemModel").add(new Option(S.gemModel, S.gemModel));
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
$("gemLoad").onclick = async () => {
  const key = $("gemKey").value.trim();
  if (!key) { $("gemMsg").textContent = "API 키를 먼저 넣어 주세요."; return; }
  $("gemMsg").textContent = "불러오는 중…";
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
    if (!r.ok) throw new Error(r.status === 400 || r.status === 403 ? "API 키가 맞지 않아요." : `오류 ${r.status}`);
    const { models = [] } = await r.json();
    const ok = models
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && /gemini/.test(m.name) && !/embedding|image|tts|audio|live|vision|aqa/.test(m.name))
      .map((m) => m.name.replace(/^models\//, ""));
    // flash first (fast + generous free tier), newest-looking names first
    ok.sort((a, b) => (/flash/.test(b) - /flash/.test(a)) || (/lite/.test(a) - /lite/.test(b)) || b.localeCompare(a));
    const sel = $("gemModel"), keep = sel.value; sel.textContent = "";
    ok.forEach((n) => sel.add(new Option(n + (/flash/.test(n) && !/lite/.test(n) ? " (추천)" : ""), n)));
    sel.value = ok.includes(keep) ? keep : ok[0];
    $("gemMsg").textContent = `${ok.length}개 모델을 불러왔어요. 이름에 flash가 들어간 모델이 빠르고 무료 사용량이 넉넉해요.`;
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
  S.provider = $("providerSel").value;
  S.gemKey = $("gemKey").value.trim();
  S.gemModel = $("gemModel").value || "gemini-2.5-flash";
  S.engine = $("engineSel").value;
  S.elKey = $("elKey").value.trim();
  S.elVoice = $("elVoice").value;
  S.elVoiceName = $("elVoice").selectedOptions[0]?.textContent || "";
  S.elModel = $("elModel").value;
}
$("openSettings").onclick = () => { fillSettings(); show("settings"); };
$("closeSettings").onclick = () => show("home");
$("saveSettings").onclick = () => { readSettings(); saveS(); show("home"); };
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
async function gemini(body, retry = true) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(S.gemModel)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": S.gemKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = ""; try { detail = (await r.json()).error?.message || ""; } catch {}
    // some models don't accept a zero thinking budget — retry once without it
    if (retry && r.status === 400 && body.generationConfig?.thinkingConfig && !/api key/i.test(detail)) {
      const gc = { ...body.generationConfig }; delete gc.thinkingConfig;
      return gemini({ ...body, generationConfig: gc }, false);
    }
    throw new GeminiError(r.status, detail);
  }
  const j = await r.json();
  const c = j.candidates?.[0];
  if (!c?.content?.parts) throw new GeminiError("blocked", j.promptFeedback?.blockReason || c?.finishReason);
  return c.content.parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
}
const toGem = (msgs) => msgs.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

/* ---- one interface for both AIs ---- */
async function aiChat(system, messages, onText) {
  if (usingGemini()) {
    const t = await gemini({ systemInstruction: { parts: [{ text: system }] }, contents: toGem(messages),
      generationConfig: { temperature: 0.9, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } } });
    onText?.(t); return t;
  }
  const stream = client().beta.messages.stream({ model: S.model, max_tokens: 1024, system, messages, output_config: { effort: "low" }, ...fallbackOpts() });
  let acc = "";
  stream.on("text", (d) => { acc += d; onText?.(acc); });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("refusal");
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}
async function aiText(prompt) {
  if (usingGemini()) return gemini({ contents: toGem([{ role: "user", content: prompt }]), generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } } });
  const r = await client().messages.create({ model: S.model, max_tokens: 1024, output_config: { effort: "low" }, messages: [{ role: "user", content: prompt }] });
  return r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}
async function aiJSON(prompt, schema) {
  let text;
  if (usingGemini()) {
    text = await gemini({ contents: toGem([{ role: "user", content: prompt + "\n\n반드시 다음 JSON 스키마에 맞는 JSON 하나만 출력해:\n" + JSON.stringify(schema) }]),
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 16384 } });
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
  tips = []; heard = ""; elPrev = ""; $("mine").textContent = ""; $("caption").textContent = "";
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

async function haruTurn() {
  busy = true; thinking = true; setState();
  let reply = "", tip = "";
  try {
    const text = await aiChat(systemPrompt(), history, (acc) => { $("caption").textContent = acc.split("###팁")[0].trim() || "…"; });
    const i = text.indexOf("###팁");
    reply = (i < 0 ? text : text.slice(0, i)).trim();
    tip = i < 0 ? "" : text.slice(i + 4).trim().split("\n")[0].trim();
  } catch (e) {
    thinking = false; busy = false; setState();
    $("caption").textContent = errText(e);
    if (history.at(-1)?.role === "user" && history.length > 1) history.pop();
    return;
  }
  thinking = false;
  history.push({ role: "assistant", content: reply });
  if (tip) { tips.push(tip); flashTip(tip); }
  $("caption").textContent = reply;
  busy = false; setState();
  await speak(reply);
  if (inCall && !busy) listen(); // hands-free: listen as soon as Haru stops talking
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
async function speakEleven(text) {
  const body = { text: tidy(text), model_id: S.elModel };
  const vs = await voiceSettings(); if (vs) body.voice_settings = vs;
  if (S.elModel !== "eleven_v3" && elPrev) body.previous_text = elPrev; // keeps intonation consistent between turns
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(S.elVoice)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": S.elKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify(body),
  });
  elPrev = body.text;
  if (!r.ok) {
    const msg = r.status === 401 ? "ElevenLabs 키가 맞지 않아요" : r.status === 402 || r.status === 429 ? "ElevenLabs 크레딧/사용량이 부족해요" : `ElevenLabs 오류 ${r.status}`;
    throw new Error(msg);
  }
  const url = URL.createObjectURL(await r.blob());
  try {
    elAudio = new Audio(url);
    await new Promise((res, rej) => { elAudio.onended = res; elAudio.onerror = rej; elAudio.play().catch(rej); });
  } finally { URL.revokeObjectURL(url); elAudio = null; }
}
function stopSpeaking() { TextToSpeech.stop().catch(() => {}); if (elAudio) { elAudio.pause(); elAudio.onended?.(); } }

async function speak(text) {
  speaking = true; setState();
  if (S.engine === "eleven" && S.elKey && S.elVoice) {
    try { await speakEleven(text); speaking = false; setState(); if (!$("settings").hidden) $("elMsg").textContent = "✓ ElevenLabs 목소리로 재생했어요."; return; }
    catch (e) {
      const m = (e.message || "ElevenLabs 연결 실패") + " · 휴대폰 목소리로 대신 말했어요";
      flashTip(m); if (!$("settings").hidden) $("elMsg").textContent = "⚠ " + m;
    }
  }
  try {
    const opt = { text, lang: "ko-KR", rate: S.rate, pitch: S.pitch, volume: 1, category: "playback" };
    if (S.voice >= 0) opt.voice = S.voice;
    await TextToSpeech.speak(opt);
  } catch {
    await new Promise((r) => setTimeout(r, Math.min(8000, text.length * 110)));
  }
  speaking = false; setState();
}

/* ---- speech in ---- */
SpeechRecognition.addListener("partialResults", (d) => {
  heard = d.matches?.[0] || heard;
  $("mine").textContent = heard;
});
SpeechRecognition.addListener("listeningState", (d) => {
  if (d.status === "started") { listening = true; setState(); return; }
  listening = false; setState();
  const t = heard.trim(); heard = "";
  if (t && inCall && !busy) userSays(t);
});
async function listen() {
  if (!inCall || listening) return;
  heard = ""; $("mine").textContent = "듣고 있어요… 말해 보세요";
  try {
    stopSpeaking();
    await SpeechRecognition.start({ language: "ko-KR", partialResults: true, popup: false, maxResults: 1 });
  } catch {
    listening = false; setState(); $("mine").textContent = "마이크를 쓸 수 없어요. 아래에 글로 입력해 주세요.";
  }
}
$("micBtn").onclick = () => { if (listening) SpeechRecognition.stop().catch(() => {}); else listen(); };
$("typeForm").onsubmit = (e) => {
  e.preventDefault();
  const t = $("typeInput").value.trim(); if (!t || busy || !inCall) return;
  $("typeInput").value = ""; $("mine").textContent = t;
  if (listening) { heard = ""; SpeechRecognition.stop().catch(() => {}); }
  userSays(t);
};
function userSays(t) { $("mine").textContent = t; history.push({ role: "user", content: t }); haruTurn(); }

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
  inCall = false; clearInterval(timerId);
  SpeechRecognition.stop().catch(() => {}); stopSpeaking();
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
