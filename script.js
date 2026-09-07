"use strict";

// 使用するHTML要素をまとめて取得します。
const textInput = document.getElementById("text-input");
const characterCount = document.getElementById("character-count");
const voiceSelect = document.getElementById("voice-select");
const rateInput = document.getElementById("rate-input");
const rateOutput = document.getElementById("rate-output");
const speakButton = document.getElementById("speak-button");
const clipboardButton = document.getElementById("clipboard-button");
const pauseButton = document.getElementById("pause-button");
const stopButton = document.getElementById("stop-button");
const statusText = document.getElementById("status");
const currentSection = document.getElementById("current-section");
const currentText = document.getElementById("current-text");
const progressText = document.getElementById("progress-text");

const synthesis = window.speechSynthesis;
const MAX_CHUNK_LENGTH = 180;

let voices = [];
let chunks = [];
let currentChunkIndex = 0;
let isReading = false;
let sessionId = 0;

/**
 * ブラウザが提供する音声を取得し、日本語音声を先頭にして表示します。
 * 音声一覧はブラウザによって非同期で読み込まれることがあります。
 */
function loadVoices() {
  const selectedVoiceURI = voiceSelect.value;
  voices = synthesis.getVoices().sort((a, b) => {
    const aJapanese = a.lang.toLowerCase().startsWith("ja") ? 0 : 1;
    const bJapanese = b.lang.toLowerCase().startsWith("ja") ? 0 : 1;
    return aJapanese - bJapanese || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
  });

  voiceSelect.replaceChildren();

  if (voices.length === 0) {
    const option = new Option("利用できる音声が見つかりません", "");
    voiceSelect.add(option);
    voiceSelect.disabled = true;
    return;
  }

  voiceSelect.disabled = false;
  voices.forEach((voice) => {
    const japaneseLabel = voice.lang.toLowerCase().startsWith("ja") ? "日本語 / " : "";
    const localLabel = voice.localService ? "" : "（オンライン）";
    voiceSelect.add(new Option(`${japaneseLabel}${voice.name}［${voice.lang}］${localLabel}`, voice.voiceURI));
  });

  // 選択済みの音声を維持し、初回は日本語音声の「七海」を最優先します。
  const previousVoice = voices.find((voice) => voice.voiceURI === selectedVoiceURI);
  const nanamiVoice = voices.find((voice) => {
    const isJapanese = voice.lang.toLowerCase().startsWith("ja");
    const voiceIdentifier = `${voice.name} ${voice.voiceURI}`;
    return isJapanese && /七海|nanami/i.test(voiceIdentifier);
  });
  const preferredVoice = previousVoice
    || nanamiVoice
    || voices.find((voice) => voice.lang.toLowerCase().startsWith("ja") && voice.default)
    || voices.find((voice) => voice.lang.toLowerCase().startsWith("ja"))
    || voices.find((voice) => voice.default)
    || voices[0];
  voiceSelect.value = preferredVoice.voiceURI;
}

/**
 * 長文が途中で止まりにくいよう、句読点や改行を優先して分割します。
 * 句読点がない長い文章は、空白を優先しつつ指定文字数以内に収めます。
 */
function splitText(text, maxLength = MAX_CHUNK_LENGTH) {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  // 文末記号と改行を別々の単位として取得し、入力された改行を保持します。
  const sentences = normalized.match(/[^。！？!?\n]+[。！？!?]?|\n/g) || [normalized];
  const result = [];
  let buffer = "";

  const pushLongPart = (part) => {
    let remaining = part.trim();
    while (remaining.length > maxLength) {
      let splitAt = remaining.lastIndexOf(" ", maxLength);
      if (splitAt < Math.floor(maxLength * 0.5)) splitAt = maxLength;
      result.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }
    return remaining;
  };

  sentences.forEach((sentence) => {
    if (sentence === "\n") {
      if (buffer.length + 1 > maxLength) {
        result.push(buffer);
        buffer = "";
      } else {
        buffer += "\n";
      }
      return;
    }

    const part = sentence.trim();
    if (!part) return;

    if ((buffer + part).length <= maxLength) {
      buffer += part;
      return;
    }

    if (buffer) {
      result.push(buffer);
      buffer = "";
    }

    buffer = part.length > maxLength ? pushLongPart(part) : part;
  });

  if (buffer) result.push(buffer);
  return result.map((chunk) => chunk.replace(/^\n+|\n+$/g, "")).filter(Boolean);
}

/**
 * 現在の文章を表示し、指定範囲を安全にハイライトします。
 * highlightLengthが0の場合は文章全体を通常表示します。
 */
function renderCurrentText(text, highlightStart = 0, highlightLength = 0) {
  currentText.replaceChildren();

  if (highlightLength <= 0) {
    currentText.textContent = text;
    return;
  }

  const safeStart = Math.max(0, Math.min(highlightStart, text.length));
  const safeEnd = Math.max(safeStart, Math.min(safeStart + highlightLength, text.length));
  const highlightedText = text.slice(safeStart, safeEnd);

  currentText.append(document.createTextNode(text.slice(0, safeStart)));
  const mark = document.createElement("mark");
  mark.className = "spoken-highlight";
  mark.textContent = highlightedText;
  currentText.append(mark, document.createTextNode(text.slice(safeEnd)));
}

// boundaryイベントの位置から、日本語の単語として強調する範囲を求めます。
function getHighlightRange(text, charIndex, charLength) {
  const start = Math.max(0, Math.min(charIndex, text.length));
  if (charLength > 0) return { start, length: charLength };

  if (typeof Intl.Segmenter === "function") {
    const segments = new Intl.Segmenter("ja", { granularity: "word" }).segment(text);
    for (const segment of segments) {
      const end = segment.index + segment.segment.length;
      if (segment.index <= start && start < end && segment.isWordLike) {
        return { start: segment.index, length: segment.segment.length };
      }
      if (segment.index >= start && segment.isWordLike) {
        return { start: segment.index, length: segment.segment.length };
      }
    }
  }

  // 単語情報がないブラウザでは、Unicode文字を1文字だけ強調します。
  const character = Array.from(text.slice(start))[0] || "";
  return { start, length: character.length };
}

// 再生状態に合わせてボタンと案内表示を更新します。
function updateControls(state) {
  const active = state === "speaking" || state === "paused";
  pauseButton.disabled = !active;
  stopButton.disabled = !active;
  pauseButton.innerHTML = state === "paused"
    ? '<span aria-hidden="true">▶</span> 再開'
    : '<span aria-hidden="true">⏸</span> 一時停止';
  statusText.classList.remove("error");

  if (state === "speaking") statusText.textContent = "読み上げ中です";
  if (state === "paused") statusText.textContent = "一時停止中です";
  if (state === "idle") statusText.textContent = "待機中";
  if (state === "finished") statusText.textContent = "読み上げが完了しました";
}

function showError(message) {
  statusText.textContent = message;
  statusText.classList.add("error");
}

// 現在のチャンクを読み上げます。完了すると次のチャンクへ進みます。
function speakCurrentChunk(activeSessionId) {
  if (!isReading || activeSessionId !== sessionId) return;

  if (currentChunkIndex >= chunks.length) {
    isReading = false;
    currentSection.hidden = true;
    updateControls("finished");
    return;
  }

  const utterance = new SpeechSynthesisUtterance(chunks[currentChunkIndex]);
  const selectedVoice = voices.find((voice) => voice.voiceURI === voiceSelect.value);
  if (selectedVoice) {
    utterance.voice = selectedVoice;
    utterance.lang = selectedVoice.lang;
  } else {
    utterance.lang = "ja-JP";
  }
  utterance.rate = Number(rateInput.value);

  const activeChunk = chunks[currentChunkIndex];
  const initialRange = getHighlightRange(activeChunk, 0, 0);
  renderCurrentText(activeChunk, initialRange.start, initialRange.length);
  progressText.textContent = `${currentChunkIndex + 1} / ${chunks.length}`;
  currentSection.hidden = false;

  // ブラウザから読み上げ位置が通知されるたび、該当する語句を強調します。
  utterance.onboundary = (event) => {
    if (!isReading || activeSessionId !== sessionId) return;
    const range = getHighlightRange(activeChunk, event.charIndex, event.charLength || 0);
    renderCurrentText(activeChunk, range.start, range.length);
  };

  utterance.onend = () => {
    if (!isReading || activeSessionId !== sessionId) return;
    currentChunkIndex += 1;
    speakCurrentChunk(activeSessionId);
  };

  utterance.onerror = (event) => {
    // cancel / interrupted は停止操作や再生し直した際にも発生するため表示しません。
    if (!isReading || activeSessionId !== sessionId || ["canceled", "interrupted"].includes(event.error)) return;
    isReading = false;
    updateControls("idle");
    showError("読み上げ中にエラーが発生しました。別の音声をお試しください。");
  };

  synthesis.speak(utterance);
}

// 新しい読み上げを始める前に、必ず現在の読み上げを停止します。
function startSpeaking() {
  const text = textInput.value.trim();
  if (!text) {
    showError("読み上げる文章を入力してください。");
    textInput.focus();
    return;
  }

  synthesis.cancel();
  sessionId += 1;
  chunks = splitText(text);
  currentChunkIndex = 0;
  isReading = true;
  updateControls("speaking");
  speakCurrentChunk(sessionId);
}

function togglePause() {
  if (!isReading) return;

  if (synthesis.paused) {
    synthesis.resume();
    updateControls("speaking");
  } else {
    synthesis.pause();
    updateControls("paused");
  }
}

function stopSpeaking(showIdleState = true) {
  sessionId += 1;
  isReading = false;
  synthesis.cancel();
  currentSection.hidden = true;
  if (showIdleState) updateControls("idle");
}

// 入力欄の内容に合わせて、Unicode文字単位の文字数を表示します。
function updateCharacterCount() {
  characterCount.textContent = `${Array.from(textInput.value).length.toLocaleString("ja-JP")}文字`;
}

// 現在の再生と入力内容をクリアし、新しい文章を受け取れる状態にします。
function clearBeforeClipboardReading() {
  stopSpeaking();
  textInput.value = "";
  updateCharacterCount();
}

/**
 * 貼り付けた文章から絵文字を除去します。
 * 国旗、肌色付き絵文字、ZWJで結合された絵文字、キーキャップにも対応します。
 */
function removeEmojis(text) {
  const emojiSequence = /(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0E|\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0E|\uFE0F|\p{Emoji_Modifier})?)*)[\t \u3000]?/gu;
  const emojiParts = /[\u200D\uFE0E\uFE0F]|\p{Emoji_Modifier}/gu;

  return text
    .replace(emojiSequence, "")
    .replace(emojiParts, "");
}

/**
 * 貼り付ける文章を整形します。
 * 絵文字を削除し、空白やタブしか含まない行を取り除きます。
 */
function sanitizePastedText(text) {
  return removeEmojis(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

/**
 * クリップボードの文章を入力欄へ取り込み、すぐに読み上げます。
 * Clipboard APIはブラウザの仕様によりHTTPSまたはlocalhostが必要な場合があります。
 */
async function readFromClipboard() {
  // 読み取りの成否にかかわらず、先に以前の文章と読み上げをクリアします。
  clearBeforeClipboardReading();

  if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
    showError("この環境では自動で読み込めません。入力欄を選択して貼り付けてください。");
    textInput.focus();
    return;
  }

  clipboardButton.disabled = true;
  clipboardButton.innerHTML = '<span aria-hidden="true">…</span> 読み込み中';

  try {
    const clipboardText = await navigator.clipboard.readText();
    const sanitizedText = sanitizePastedText(clipboardText);
    if (!sanitizedText.trim()) {
      showError("絵文字と空行を除くと、読み上げ可能な文章がありません。");
      return;
    }

    textInput.value = sanitizedText;
    updateCharacterCount();
    startSpeaking();
  } catch (error) {
    console.warn("クリップボードの読み取りに失敗しました。", error);
    const securityHint = window.isSecureContext
      ? "ブラウザのクリップボード権限を許可してください。"
      : "許可確認なしで使うには、入力欄を選択してCtrl+Vで貼り付けてください。";
    showError(`クリップボードを読み込めませんでした。${securityHint}`);
    textInput.focus();
  } finally {
    clipboardButton.disabled = false;
    clipboardButton.innerHTML = '<span aria-hidden="true">📋</span> クリップボードから読み上げ';
  }
}

textInput.addEventListener("input", () => {
  updateCharacterCount();
  if (statusText.classList.contains("error")) updateControls(isReading ? "speaking" : "idle");
});

/**
 * ユーザー自身による貼り付けは権限ダイアログが不要です。
 * 既存内容を残さず、貼り付けられたテキストだけをすぐに読み上げます。
 */
textInput.addEventListener("paste", (event) => {
  const pastedText = event.clipboardData?.getData("text/plain") || "";
  if (!pastedText.trim()) return;

  event.preventDefault();
  clearBeforeClipboardReading();
  const sanitizedText = sanitizePastedText(pastedText);
  if (!sanitizedText.trim()) {
    showError("絵文字と空行を除くと、読み上げ可能な文章がありません。");
    return;
  }

  textInput.value = sanitizedText;
  updateCharacterCount();
  startSpeaking();
});

rateInput.addEventListener("input", () => {
  const rate = Number(rateInput.value).toFixed(1);
  rateOutput.textContent = `${rate}倍`;
  rateInput.setAttribute("aria-valuetext", `${rate}倍`);
});

speakButton.addEventListener("click", startSpeaking);
clipboardButton.addEventListener("click", readFromClipboard);
pauseButton.addEventListener("click", togglePause);
stopButton.addEventListener("click", () => stopSpeaking());

// ページを離れるときにブラウザへ残っている読み上げを確実に解除します。
window.addEventListener("pagehide", () => stopSpeaking(false));
window.addEventListener("beforeunload", () => synthesis.cancel());

if ("speechSynthesis" in window && "SpeechSynthesisUtterance" in window) {
  loadVoices();
  synthesis.addEventListener("voiceschanged", loadVoices);
} else {
  speakButton.disabled = true;
  clipboardButton.disabled = true;
  pauseButton.disabled = true;
  stopButton.disabled = true;
  showError("このブラウザは音声読み上げ機能に対応していません。Chrome、Edge、Safariなどをお試しください。");
}