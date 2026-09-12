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
const currentTitleText = document.getElementById("current-title-text");
const currentText = document.getElementById("current-text");
const progressText = document.getElementById("progress-text");
const ocrZone = document.getElementById("ocr-zone");
const ocrButton = document.getElementById("ocr-button");
const ocrFileInput = document.getElementById("ocr-file");
const ocrProgress = document.getElementById("ocr-progress");
const ocrProgressFill = document.getElementById("ocr-progress-fill");
const ocrProgressLabel = document.getElementById("ocr-progress-label");

const synthesis = window.speechSynthesis;
const MAX_CHUNK_LENGTH = 180;
const FINISH_ANNOUNCEMENT = "以上で読み上げを終了します。";

// 読み上げが無言のまま止まってしまう不具合を検知し、自動で復帰するための設定です。
// ブラウザによっては1回の発話が15秒ほどを超えると、onend/onerrorのどちらも発火せずに停止します。
const STALL_CHECK_INTERVAL = 1000;
const STALL_GRACE_MS = 5000;
const ESTIMATED_MS_PER_CHARACTER = 220;
const STALL_EXTRA_MARGIN_MS = 6000;
const RESTART_DELAY_MS = 150;
const MAX_SKIP_ATTEMPTS = 3;
const SKIP_STEP_LENGTH = 4;
const MAX_FAILURE_STREAK = 4;
const KEEP_ALIVE_INTERVAL = 10000;
const RECOVERY_NOTICE_DURATION = 4000;

// pause/resumeによる時間切れ対策はパソコン向けブラウザでのみ有効なため、端末を判定します。
const isMobileBrowser = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

let voices = [];
let chunks = [];
let realChunkCount = 0;
let currentChunkIndex = 0;
let currentChunkOffset = 0;
let isReading = false;
let isPaused = false;
let sessionId = 0;
let utteranceId = 0;

// 停止検知（ウォッチドッグ）で使う状態です。
let watchdogTimerId = 0;
let keepAliveTimerId = 0;
let noticeTimerId = 0;
let restartTimerId = 0;
let lastProgressAt = 0;
let boundaryCount = 0;
let maxBoundaryGap = 0;
let expectedDurationMs = 0;
let lastSpokenOffset = 0;
let recoveryOffset = -1;
let skipAttempts = 0;
let failureStreak = 0;
let hasSpokenAnything = false;
let isRecovering = false;

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
 * 読み上げエンジンが内部でSSML（XML）を組み立てる場合に、
 * 「&」「<」「>」があると合成に失敗して無言のまま止まることがあります。
 * 見た目と文字数を変えずに済む全角記号へ置き換えて、その停止を防ぎます。
 */
function replaceUnsafeSymbols(text) {
  return text
    .replace(/&/g, "＆")
    .replace(/</g, "＜")
    .replace(/>/g, "＞");
}

/**
 * 長文が途中で止まりにくいよう、句読点や改行を優先して分割します。
 * 句読点がない長い文章は、空白を優先しつつ指定文字数以内に収めます。
 */
function splitText(text, maxLength = MAX_CHUNK_LENGTH) {
  const normalized = replaceUnsafeSymbols(text.replace(/\r\n?/g, "\n")).trim();
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

/**
 * iOSのページコントロールのように、チャンクの進み具合をドットで表示します。
 * 読み終えたチャンクは塗りつぶし、現在のチャンクは強調し、これからのチャンクは薄く表示します。
 */
function renderProgressDots(current, total) {
  progressText.setAttribute("role", "img");
  progressText.setAttribute("aria-label", `${current} / ${total}`);

  const fragment = document.createDocumentFragment();
  for (let index = 0; index < total; index += 1) {
    const dot = document.createElement("span");
    dot.className = "progress-dot";
    if (index < current - 1) dot.classList.add("is-done");
    else if (index === current - 1) dot.classList.add("is-current");
    fragment.append(dot);
  }
  progressText.replaceChildren(fragment);
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

// 再生状態に合わせてボタン・案内表示・ポップアップの見た目を更新します。
function updateControls(state) {
  const active = state === "speaking" || state === "paused";
  const paused = state === "paused";
  pauseButton.disabled = !active;
  stopButton.disabled = !active;
  pauseButton.innerHTML = paused
    ? '<span aria-hidden="true">▶</span> 再開'
    : '<span aria-hidden="true">⏸</span> 一時停止';
  statusText.classList.remove("error");

  if (state === "speaking") statusText.textContent = "読み上げ中です";
  if (state === "paused") statusText.textContent = "一時停止中です";
  if (state === "idle") statusText.textContent = "待機中";
  if (state === "finished") statusText.textContent = "読み上げが完了しました";

  currentSection.classList.toggle("is-paused", paused);
  currentSection.setAttribute("aria-pressed", String(paused));
  currentTitleText.textContent = paused ? "一時停止中" : "現在読み上げ中";
}

function showError(message) {
  statusText.textContent = message;
  statusText.classList.add("error");
}

// 自動で読み上げ位置を進めたことを、一時的に案内表示へ出します。
function showRecoveryNotice(message) {
  window.clearTimeout(noticeTimerId);
  statusText.classList.remove("error");
  statusText.textContent = message;
  noticeTimerId = window.setTimeout(() => {
    if (isReading && !isPaused) updateControls("speaking");
  }, RECOVERY_NOTICE_DURATION);
}

/**
 * 止まった位置から少しだけ先へ進んだ位置を返します。
 * やり直すたびに飛ばす量を増やしつつ、読み飛ばす文字数は最小限にとどめます。
 */
function findSkipOffset(text, from, attempt) {
  return Math.min(from + SKIP_STEP_LENGTH * Math.max(1, attempt), text.length);
}

/**
 * 読み上げが止まった、または失敗したときに、続きから読み直します。
 * 直前の停止位置より進んでいれば同じ位置から、進んでいなければ少し先へ飛ばします。
 * 同じ場所で繰り返し止まる場合は、その文をあきらめて次の文へ進みます。
 * 一度も読み進められないまま失敗が続く場合は、環境側の問題としてエラーを表示します。
 */
function recoverFromInterruption(isError) {
  const activeSessionId = sessionId;
  const activeChunk = chunks[currentChunkIndex] || "";
  const stalledOffset = Math.max(currentChunkOffset, lastSpokenOffset);
  const stalledChunkIndex = currentChunkIndex;

  // 止まった発話に紐づくイベントを無効化してから、読み上げを解除します。
  // 内部的に一時停止状態のまま固まっている場合があるため、resumeしてからcancelします。
  isRecovering = true;
  utteranceId += 1;
  synthesis.resume();
  synthesis.cancel();

  failureStreak += 1;
  if (failureStreak > MAX_FAILURE_STREAK) {
    // 何度やり直しても1文字も進まない場合は、音声そのものが使えないと判断します。
    isReading = false;
    isPaused = false;
    stopPlaybackTimers();
    currentSection.hidden = true;
    updateControls("idle");
    showError("読み上げを続けられませんでした。別の音声をお試しください。");
    return;
  }

  const madeProgress = stalledOffset > recoveryOffset;
  if (madeProgress) skipAttempts = 0;
  else skipAttempts += 1;

  const nextOffset = madeProgress ? stalledOffset : findSkipOffset(activeChunk, stalledOffset, skipAttempts);
  const skipToNextChunk = skipAttempts > MAX_SKIP_ATTEMPTS || nextOffset >= activeChunk.length;

  const trouble = isError ? "読み上げに失敗したため" : "読み上げが止まったため";
  showRecoveryNotice(skipToNextChunk
    ? `${trouble}、次の文へ進みます`
    : `${trouble}、少し先から読み上げます`);

  // cancel直後のspeakは無視されることがあるため、少しだけ間をあけてから再開します。
  window.clearTimeout(restartTimerId);
  restartTimerId = window.setTimeout(() => {
    isRecovering = false;
    if (!isReading || isPaused || activeSessionId !== sessionId) return;

    if (skipToNextChunk) {
      currentChunkIndex = stalledChunkIndex + 1;
      currentChunkOffset = 0;
      recoveryOffset = -1;
      skipAttempts = 0;
      speakCurrentChunk(activeSessionId);
      return;
    }

    recoveryOffset = nextOffset;
    speakCurrentChunk(activeSessionId, nextOffset);
  }, RESTART_DELAY_MS);
}

/**
 * 一定時間ごとに読み上げが進んでいるかを確認します。
 * boundaryイベントの間隔から判断し、通知が届かないブラウザでは
 * 文字数から見積もった所要時間を目安にします。
 */
function checkForStall() {
  if (!isReading || isPaused || isRecovering) return;

  const idleMs = Date.now() - lastProgressAt;
  const limitMs = boundaryCount >= 3
    ? Math.max(STALL_GRACE_MS, maxBoundaryGap * 3)
    : expectedDurationMs + STALL_EXTRA_MARGIN_MS;

  if (idleMs < limitMs) return;
  recoverFromInterruption(false);
}

// 読み上げ中だけ、停止検知と長文対策のタイマーを動かします。
function startPlaybackTimers() {
  stopPlaybackTimers();
  watchdogTimerId = window.setInterval(checkForStall, STALL_CHECK_INTERVAL);
  // 長い発話が15秒ほどで勝手に止まるブラウザの不具合を避けるため、定期的に再開を促します。
  // パソコン向けブラウザではpauseとresumeを続けて呼ぶことで、内部の時間切れを回避できます。
  keepAliveTimerId = window.setInterval(() => {
    if (!isReading || isPaused || isRecovering) return;
    if (isMobileBrowser) {
      synthesis.resume();
      return;
    }
    synthesis.pause();
    synthesis.resume();
  }, KEEP_ALIVE_INTERVAL);
}

function stopPlaybackTimers() {
  window.clearInterval(watchdogTimerId);
  window.clearInterval(keepAliveTimerId);
  window.clearTimeout(noticeTimerId);
  window.clearTimeout(restartTimerId);
  watchdogTimerId = 0;
  keepAliveTimerId = 0;
  noticeTimerId = 0;
  restartTimerId = 0;
  isRecovering = false;
}

// 現在のチャンクをstartOffset文字目から読み上げます。完了すると次のチャンクへ進みます。
// 一時停止からの再開もこの関数を使い、続きの文字列から新しい発話を開始します。
function speakCurrentChunk(activeSessionId, startOffset = 0) {
  if (!isReading || activeSessionId !== sessionId) return;

  if (currentChunkIndex >= chunks.length) {
    isReading = false;
    isPaused = false;
    stopPlaybackTimers();
    currentSection.hidden = true;
    if (hasSpokenAnything) updateControls("finished");
    else showError("読み上げを開始できませんでした。別の音声をお試しください。");
    return;
  }

  const activeChunk = chunks[currentChunkIndex];
  const safeStartOffset = Math.max(0, Math.min(startOffset, activeChunk.length));
  currentChunkOffset = safeStartOffset;

  // 読み上げる文字が残っていない場合は、発話せずに次の文へ進みます。
  // 空の発話はブラウザによってendイベントが届かず、止まったままになることがあります。
  const spokenText = activeChunk.slice(safeStartOffset);
  if (!spokenText.trim()) {
    currentChunkIndex += 1;
    currentChunkOffset = 0;
    recoveryOffset = -1;
    skipAttempts = 0;
    speakCurrentChunk(activeSessionId);
    return;
  }

  const activeUtteranceId = ++utteranceId;

  const utterance = new SpeechSynthesisUtterance(spokenText);
  const selectedVoice = voices.find((voice) => voice.voiceURI === voiceSelect.value);
  if (selectedVoice) {
    utterance.voice = selectedVoice;
    utterance.lang = selectedVoice.lang;
  } else {
    utterance.lang = "ja-JP";
  }
  const rate = Number(rateInput.value) || 1;
  utterance.rate = rate;

  // 停止検知の基準を、この発話に合わせて初期化します。
  lastProgressAt = Date.now();
  lastSpokenOffset = safeStartOffset;
  boundaryCount = 0;
  maxBoundaryGap = 0;
  expectedDurationMs = (spokenText.length * ESTIMATED_MS_PER_CHARACTER) / rate;

  const initialRange = getHighlightRange(activeChunk, safeStartOffset, 0);
  renderCurrentText(activeChunk, initialRange.start, initialRange.length);
  if (currentChunkIndex < realChunkCount) {
    renderProgressDots(currentChunkIndex + 1, realChunkCount);
  } else {
    progressText.removeAttribute("role");
    progressText.removeAttribute("aria-label");
    progressText.textContent = "読み上げ終了";
  }
  currentSection.hidden = false;

  const isStaleUtterance = () => !isReading || activeSessionId !== sessionId || activeUtteranceId !== utteranceId;

  // ブラウザから読み上げ位置が通知されるたび、該当する語句を強調します。
  // charIndexは発話に渡した部分文字列を基準とするため、safeStartOffset分を足して元の文字列上の位置に直します。
  utterance.onboundary = (event) => {
    if (isStaleUtterance()) return;

    // 読み上げが進んでいる証拠として、通知の間隔を記録します。
    const now = Date.now();
    if (boundaryCount > 0) maxBoundaryGap = Math.max(maxBoundaryGap, now - lastProgressAt);
    boundaryCount += 1;
    lastProgressAt = now;
    failureStreak = 0;
    hasSpokenAnything = true;

    // ハイライト位置は単語の先頭へ戻ることがあるため、到達位置は別に記録します。
    const spokenOffset = safeStartOffset + event.charIndex;
    lastSpokenOffset = Math.max(lastSpokenOffset, spokenOffset);

    const range = getHighlightRange(activeChunk, spokenOffset, event.charLength || 0);
    currentChunkOffset = range.start;
    renderCurrentText(activeChunk, range.start, range.length);
  };

  utterance.onend = () => {
    if (isStaleUtterance()) return;
    hasSpokenAnything = true;
    currentChunkIndex += 1;
    currentChunkOffset = 0;
    recoveryOffset = -1;
    skipAttempts = 0;
    failureStreak = 0;
    speakCurrentChunk(activeSessionId);
  };

  // 一部の記号やオンライン音声の通信状況が原因で、特定の箇所だけ合成に失敗することがあります。
  // その場合もここで終わらせず、少し先から読み上げをやり直して続きを再生します。
  utterance.onerror = (event) => {
    // cancel / interrupted は、停止・一時停止・再生し直した際にも発生するため無視します。
    if (isStaleUtterance() || ["canceled", "interrupted"].includes(event.error)) return;
    if (isRecovering) return;
    console.warn("読み上げでエラーが発生しました。", event.error);
    recoverFromInterruption(true);
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
  const realChunks = splitText(text);
  realChunkCount = realChunks.length;
  // 最後に終了アナウンスを疑似チャンクとして追加し、読み上げ完了後にひと言添えてから閉じます。
  chunks = [...realChunks, FINISH_ANNOUNCEMENT];
  currentChunkIndex = 0;
  currentChunkOffset = 0;
  recoveryOffset = -1;
  skipAttempts = 0;
  failureStreak = 0;
  hasSpokenAnything = false;
  isReading = true;
  isPaused = false;
  updateControls("speaking");
  startPlaybackTimers();
  speakCurrentChunk(sessionId);
}

// speechSynthesisのpause/resumeはブラウザによって再開に失敗することがあるため使用せず、
// 一時停止時は現在位置を記録して読み上げをcancelし、再開時はその続きから新しい発話を始めます。
function togglePause() {
  if (!isReading) return;

  if (isPaused) {
    isPaused = false;
    updateControls("speaking");
    startPlaybackTimers();
    speakCurrentChunk(sessionId, currentChunkOffset);
  } else {
    isPaused = true;
    stopPlaybackTimers();
    updateControls("paused");
    synthesis.cancel();
  }
}

function stopSpeaking(showIdleState = true) {
  sessionId += 1;
  isReading = false;
  isPaused = false;
  currentChunkOffset = 0;
  recoveryOffset = -1;
  skipAttempts = 0;
  failureStreak = 0;
  stopPlaybackTimers();
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
 * 貼り付けた文章からURLと%エンコードされた文字列を除去します。
 * URLを囲む丸括弧（半角・全角）が残らないよう、括弧ごと取り除きます。
 */
function removeUrlsAndPercentEncoding(text) {
  return text
    .replace(/[(（]?https?:\/\/\S+[)）]?/gi, "")
    .replace(/(?:%[0-9A-Fa-f]{2})+/g, "");
}

/**
 * 貼り付けた文章に含まれるMarkdown記法のノイズを取り除きます。
 * 見出し（#）や箇条書き（*）は改行に変換し、太字（**）の記号は削除します。
 * ブラウザが段落の改行を保持せずに1行へつなげてしまった場合でも、
 * これらの記号を手がかりに元の段落・箇条書きの区切りを復元します。
 */
function stripMarkdownNoise(text) {
  return text
    .replace(/[ \t]*#{1,6}[ \t]+/g, "\n")
    .replace(/\*\*/g, "")
    .replace(/[ \t]*\*[ \t]*/g, "\n");
}

/**
 * 貼り付ける文章を整形します。
 * 絵文字・URL・%エンコード文字列・Markdown記法を削除し、
 * 空白やタブしか含まない行を取り除きます。
 */
function sanitizePastedText(text) {
  return stripMarkdownNoise(removeUrlsAndPercentEncoding(removeEmojis(text)))
    .replace(/\r\n?|\u2028|\u2029/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
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

// ===== 画像から文字を読み取る（OCR） =====
// Tesseract.jsをCDNから読み込み、ブラウザの中だけで処理します。サーバーやAPIキーは不要です。

const TESSERACT_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js";
const OCR_LANGUAGE = "jpn";

// Tesseract.jsが知らせてくる処理段階を、日本語の表示に置き換えます。
const OCR_STEP_LABELS = {
  "loading tesseract core": "エンジンを準備中",
  "initializing tesseract": "エンジンを準備中",
  "loading language traineddata": "日本語データを取得中",
  "initializing api": "読み取りの準備中",
  "recognizing text": "文字を読み取り中",
};

let tesseractLoader = null;
let isOcrRunning = false;

// Tesseract.jsは初回の読み取り時にだけ読み込み、ページの表示を遅くしないようにします。
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);

  if (!tesseractLoader) {
    tesseractLoader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = TESSERACT_SCRIPT_URL;
      script.onload = () => resolve(window.Tesseract);
      script.onerror = () => {
        tesseractLoader = null;
        reject(new Error("Tesseract.jsを読み込めませんでした。"));
      };
      document.head.appendChild(script);
    });
  }

  return tesseractLoader;
}

// ドラッグ・貼り付けされたものから、最初の画像ファイルを取り出します。
function findImageFile(dataTransfer) {
  return Array.from(dataTransfer?.files || []).find((file) => file.type.startsWith("image/")) || null;
}

function hasDraggedFiles(dataTransfer) {
  return Array.from(dataTransfer?.types || []).includes("Files");
}

function showOcrProgress(label, ratio) {
  const percent = Math.round(Math.min(Math.max(ratio, 0), 1) * 100);
  ocrProgress.hidden = false;
  ocrProgressFill.style.width = `${percent}%`;
  ocrProgressLabel.textContent = `${label}… ${percent}%`;
}

function hideOcrProgress() {
  ocrProgress.hidden = true;
  ocrProgressFill.style.width = "0%";
}

function handleOcrProgress(log) {
  const label = OCR_STEP_LABELS[log?.status];
  if (!label) return;
  showOcrProgress(label, typeof log.progress === "number" ? log.progress : 0);
}

/**
 * OCRは日本語の文字と文字の間にも空白を入れることがあるため、それを取り除きます。
 * 英単語の区切りの空白は残します。
 */
function removeSpacesBetweenJapanese(text) {
  const japanese = "\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}ー々〆、。，．・！？「」『』（）";
  return text.replace(new RegExp(`([${japanese}])[ \\t\u3000]+(?=[${japanese}])`, "gu"), "$1");
}

// 読み取った文字を、貼り付け時と同じ整形処理でそのまま使える文章にします。
function cleanOcrText(text) {
  return sanitizePastedText(removeSpacesBetweenJapanese(text));
}

function setOcrBusy(isBusy) {
  ocrButton.disabled = isBusy;
  ocrButton.innerHTML = isBusy
    ? '<span aria-hidden="true">⏳</span> 読み取り中…'
    : '<span aria-hidden="true">📷</span> 画像から文字を読み取る';
}

/**
 * 画像ファイルから文字を読み取り、入力欄へ入れます。
 * 読み上げは自動で始めず、内容を直してから読み上げられるようにします。
 */
async function runOcr(file) {
  if (isOcrRunning) return;

  if (!file || !file.type.startsWith("image/")) {
    showError("画像ファイル（PNG・JPEGなど）を選んでください。");
    return;
  }

  isOcrRunning = true;
  // 読み上げ中に文章を入れ替えないよう、先に読み上げを止めます。
  if (isReading) stopSpeaking();
  setOcrBusy(true);
  statusText.classList.remove("error");
  statusText.textContent = "画像から文字を読み取っています";
  showOcrProgress("準備中", 0);

  try {
    const tesseract = await loadTesseract();
    const result = await tesseract.recognize(file, OCR_LANGUAGE, { logger: handleOcrProgress });
    const recognizedText = cleanOcrText(result?.data?.text || "");

    if (!recognizedText) {
      showError("画像から文字を読み取れませんでした。明るく大きく写った画像でお試しください。");
      return;
    }

    textInput.value = recognizedText;
    updateCharacterCount();
    statusText.textContent = "読み取りが完了しました。内容を直してから読み上げてください。";
    // 携帯電話ではキーボードが出てしまうため、入力欄への移動はパソコンだけにします。
    if (!isMobileBrowser) textInput.focus();
  } catch (error) {
    console.warn("画像の読み取りに失敗しました。", error);
    showError("画像の文字を読み取れませんでした。通信状況を確認して、もう一度お試しください。");
  } finally {
    isOcrRunning = false;
    hideOcrProgress();
    setOcrBusy(false);
  }
}

ocrButton.addEventListener("click", () => ocrFileInput.click());

ocrFileInput.addEventListener("change", () => {
  const file = ocrFileInput.files?.[0] || null;
  // 同じ画像を続けて選び直せるように、選択状態を消してから処理します。
  ocrFileInput.value = "";
  if (file) runOcr(file);
});

// 画像をページのどこへドロップしても読み取ります。文字のドラッグは今までどおりです。
document.addEventListener("dragover", (event) => {
  if (!hasDraggedFiles(event.dataTransfer)) return;
  event.preventDefault();
  ocrZone.classList.add("is-dragover");
});

document.addEventListener("dragleave", (event) => {
  // ページの外へ出たときだけ、受け取れる表示を戻します。
  if (event.relatedTarget) return;
  ocrZone.classList.remove("is-dragover");
});

document.addEventListener("drop", (event) => {
  if (!hasDraggedFiles(event.dataTransfer)) return;
  event.preventDefault();
  ocrZone.classList.remove("is-dragover");

  const file = findImageFile(event.dataTransfer);
  if (!file) {
    showError("画像ファイル（PNG・JPEGなど）をドロップしてください。");
    return;
  }

  runOcr(file);
});

/**
 * クリップボードの画像をCtrl+Vで読み取ります。
 * 文章が含まれるときは何もせず、これまでどおりの貼り付け動作にします。
 * 入力欄の貼り付け処理より先に判定するため、キャプチャ段階で受け取ります。
 */
document.addEventListener("paste", (event) => {
  if ((event.clipboardData?.getData("text/plain") || "").trim()) return;

  const file = findImageFile(event.clipboardData);
  if (!file) return;

  event.preventDefault();
  event.stopPropagation();
  runOcr(file);
}, true);

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

// ポップアップの枠外を押すと、閉じて読み上げを停止します。
// click ではなくpointerdownで判定することで、他ボタンのclickより先に処理します。
document.addEventListener("pointerdown", (event) => {
  if (currentSection.hidden || currentSection.contains(event.target)) return;
  stopSpeaking();
});

// ポップアップ内をクリック（タップ）すると、一時停止・再生をトグルします。
// テキスト選択（コピー目的のドラッグ操作）の直後は誤動作を避けるため無視します。
currentSection.addEventListener("click", () => {
  if (window.getSelection()?.toString()) return;
  togglePause();
});

currentSection.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  togglePause();
});

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