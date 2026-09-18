"use strict";

// 使用するHTML要素をまとめて取得します。
const textInput = document.getElementById("text-input");
const characterCount = document.getElementById("character-count");
const voiceSelect = document.getElementById("voice-select");
const voiceNote = document.getElementById("voice-note");
const aiVoiceToggle = document.getElementById("ai-voice-toggle");
const aiVoiceSelect = document.getElementById("ai-voice-select");
const rateInput = document.getElementById("rate-input");
const rateOutput = document.getElementById("rate-output");
const speakButton = document.getElementById("speak-button");
const clipboardButton = document.getElementById("clipboard-button");
const copyButton = document.getElementById("copy-button");
const pauseButton = document.getElementById("pause-button");
const stopButton = document.getElementById("stop-button");
const downloadButton = document.getElementById("download-button");
const statusText = document.getElementById("status");
const currentSection = document.getElementById("current-section");
const currentTitleText = document.getElementById("current-title-text");
const currentSource = document.getElementById("current-source");
const currentAi = document.getElementById("current-ai");
const currentText = document.getElementById("current-text");
const progressText = document.getElementById("progress-text");
const ocrProgress = document.getElementById("ocr-progress");
const ocrProgressFill = document.getElementById("ocr-progress-fill");
const ocrProgressLabel = document.getElementById("ocr-progress-label");
const processModeInputs = document.querySelectorAll('input[name="process-mode"]');
const quickModeInputs = document.querySelectorAll('input[name="quick-mode"]');
const aiResultSection = document.getElementById("ai-result");
const aiResultInput = document.getElementById("ai-result-input");
const aiResultKind = document.getElementById("ai-result-kind");
const aiResultHelp = document.getElementById("ai-result-help");
const aiResultCount = document.getElementById("ai-result-count");
const aiResultCopy = document.getElementById("ai-result-copy");
const aiResultClear = document.getElementById("ai-result-clear");
const translateLanguageField = document.getElementById("translate-language-field");
const translateLanguage = document.getElementById("translate-language");
const passwordDialog = document.getElementById("password-dialog");
const passwordForm = document.getElementById("password-form");
const passwordInput = document.getElementById("password-input");
const passwordError = document.getElementById("password-error");
const passwordSubmit = document.getElementById("password-submit");
const passwordCancel = document.getElementById("password-cancel");

const synthesis = window.speechSynthesis;
const MAX_CHUNK_LENGTH = 180;

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

// 読み上げを頼んでも音が出始めないことへの対策です。
// 他のアプリが音声エンジンを使っている間や、直前のcancelの影響で、
// speakを受け取ってもらえたまま発話が始まらないことがあります。
const START_TIMEOUT_MS = 1600;
// オンライン音声は音声データの取得に時間がかかるため、長めに待ちます。
const REMOTE_START_TIMEOUT_MS = 5000;
const START_RETRY_DELAY_MS = 250;
const MAX_START_RETRIES = 2;

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

// 発話が実際に始まるまでを見張るための状態です。
let startTimerId = 0;
let startRetryCount = 0;
let hasUtteranceStarted = false;
let isWaitingForStart = false;
let hasPrimedSynthesis = false;

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
    voiceSelect.add(new Option("利用できる音声が見つかりません", ""));
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
    startRetryCount = 0;
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
    // まだ音が出ていない発話にpauseをかけると、そのまま始まらなくなることがあるため触りません。
    if (!hasUtteranceStarted) return;
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
  window.clearTimeout(startTimerId);
  watchdogTimerId = 0;
  keepAliveTimerId = 0;
  noticeTimerId = 0;
  restartTimerId = 0;
  startTimerId = 0;
  isRecovering = false;
  isWaitingForStart = false;
  hasUtteranceStarted = false;
}

/**
 * 音声エンジンは最初の1回だけ起動に時間がかかり、読み上げ開始が遅れることがあります。
 * 画面を最初に触った時点で音量0の発話を通し、エンジンを先に起こしておきます。
 * 読み上げボタン自体の操作では行いません（直後のcancelが本来の発話を打ち消すため）。
 */
function primeSpeechSynthesis() {
  if (hasPrimedSynthesis || isReading) return;
  hasPrimedSynthesis = true;
  try {
    const warmUp = new SpeechSynthesisUtterance("\u3000");
    warmUp.volume = 0;
    warmUp.lang = "ja-JP";
    synthesis.speak(warmUp);
  } catch (error) {
    console.warn("音声エンジンの事前準備に失敗しました。", error);
  }
}

// ブラウザ側が一時停止のまま残っていると、次のspeakが受け取られても始まりません。
function releasePendingPause() {
  if (synthesis && synthesis.paused) synthesis.resume();
}

/**
 * 実際に音が出始めたことを記録し、開始待ちの見張りを解除します。
 * onstartが届かないブラウザもあるため、読み上げ位置の通知や終了でも呼びます。
 */
function markUtteranceStarted() {
  window.clearTimeout(startTimerId);
  startTimerId = 0;
  hasUtteranceStarted = true;
  startRetryCount = 0;

  if (!isWaitingForStart) return;
  isWaitingForStart = false;
  if (isReading && !isPaused) updateControls("speaking");
}

/**
 * speakを受け取ってもらえたのに音が出ないときは、音声エンジンを解除してから読み上げ直します。
 * 他のアプリが音声を使っている間などに、最初の発話だけが始まらないまま止まることがあります。
 * 何度やり直しても始まらない場合は、少し先から読み直す通常の復帰処理に任せます。
 */
function retryStalledStart(activeSessionId, startOffset) {
  if (startRetryCount >= MAX_START_RETRIES) {
    recoverFromInterruption(false);
    return;
  }

  startRetryCount += 1;
  isRecovering = true;
  isWaitingForStart = false;
  // 始まらなかった発話に紐づくイベントを無効化してから、読み上げを解除します。
  utteranceId += 1;
  synthesis.resume();
  synthesis.cancel();
  showRecoveryNotice("音声がすぐに始まらないため、読み上げをやり直します");

  // cancel直後のspeakは無視されることがあるため、少しだけ間をあけてから読み上げ直します。
  window.clearTimeout(restartTimerId);
  restartTimerId = window.setTimeout(() => {
    isRecovering = false;
    if (!isReading || isPaused || activeSessionId !== sessionId) return;
    speakCurrentChunk(activeSessionId, startOffset);
  }, START_RETRY_DELAY_MS);
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

  // 実際に音が出始めた時点を基準にすることで、準備待ちの時間を停止検知に含めません。
  utterance.onstart = () => {
    if (isStaleUtterance()) return;
    lastProgressAt = Date.now();
    markUtteranceStarted();
  };

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
    markUtteranceStarted();

    // ハイライト位置は単語の先頭へ戻ることがあるため、到達位置は別に記録します。
    const spokenOffset = safeStartOffset + event.charIndex;
    lastSpokenOffset = Math.max(lastSpokenOffset, spokenOffset);

    const range = getHighlightRange(activeChunk, spokenOffset, event.charLength || 0);
    currentChunkOffset = range.start;
    renderCurrentText(activeChunk, range.start, range.length);
  };

  utterance.onend = () => {
    if (isStaleUtterance()) return;
    markUtteranceStarted();
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

  // まだ一度も音が出ていないときは、準備中であることを画面へ出します。
  // やり直し中は、その案内を消さないようにします。
  if (!hasSpokenAnything && startRetryCount === 0) {
    isWaitingForStart = true;
    statusText.classList.remove("error");
    statusText.textContent = "音声の準備をしています…";
  }

  hasUtteranceStarted = false;
  releasePendingPause();
  synthesis.speak(utterance);

  // 読み上げを頼んでも音が出始めないことがあるため、一定時間で見張ってやり直します。
  const startLimitMs = selectedVoice && selectedVoice.localService === false
    ? REMOTE_START_TIMEOUT_MS
    : START_TIMEOUT_MS;
  window.clearTimeout(startTimerId);
  startTimerId = window.setTimeout(() => {
    startTimerId = 0;
    if (isStaleUtterance() || isPaused || isRecovering || hasUtteranceStarted) return;
    retryStalledStart(activeSessionId, safeStartOffset);
  }, startLimitMs);
}

// 新しい読み上げを始める前に、必ず現在の読み上げを停止します。
// 読み上げる文章です。AIの結果があるときは、そちらを読み上げます。
function getTextToRead() {
  const aiResult = aiResultInput.value.trim();
  return aiResult || textInput.value;
}

/**
 * 読み上げ中の見出しへ、実際に行ったことを表示します。
 * ・入力が「文字」か「画像」か
 * ・AIを使ったかどうか（使った場合は何に使ったか）
 * 選んだ処理方法をそのまま出すと、画像向けの方法を選んだまま文字を入力したときに
 * AIを使ったように見えてしまうため、実際に行ったことを出します。
 */
function updateCurrentChips() {
  const isImage = inputSourceKind === "image";
  const aiMode = getTextAiMode();
  const usesAiResult = Boolean(aiResultInput.value.trim()) && aiMode && hasFreshAiResult(aiMode);

  currentSource.textContent = isImage ? "📷 画像" : "📄 文字";
  currentSource.title = isImage
    ? (ocrEngineUsed === "ai" ? "画像をAIで読み取った文章です" : "画像をブラウザ内の無料OCRで読み取った文章です")
    : "入力欄へ文字として入れた文章です";

  let aiLabel = "AIなし";
  let aiTitle = `AIは使っていません（選んでいる処理方法: ${getProcessModeFullLabel()}）`;

  if (usesAiResult) {
    aiLabel = aiMode === "translate" ? "✨ AIで翻訳" : "✨ AIで要約";
    aiTitle = aiMode === "translate" ? "AIが翻訳した文章を読み上げています" : "AIが要約した文章を読み上げています";
  } else if (isImage && ocrEngineUsed === "ai") {
    aiLabel = "✨ AIで読取";
    aiTitle = "AIが画像から読み取った文章を読み上げています";
  } else if (!isImage && usesAiOcr()) {
    aiTitle = "AIは使っていません（高精度OCRは画像のときだけ使います）";
  }

  // AI音声で読み上げているときも、料金がかかっているため印へ加えます。
  if (isAiPlayback) {
    const voiceTitle = `AIが作った音声（${aiVoiceUsed}）で読み上げています`;
    aiTitle = aiLabel === "AIなし" ? voiceTitle : `${aiTitle}。${voiceTitle}`;
    aiLabel = aiLabel === "AIなし" ? "✨ AI音声" : `${aiLabel}＋音声`;
  }

  currentAi.textContent = aiLabel;
  currentAi.title = aiTitle;
  currentAi.classList.toggle("is-ai", aiLabel !== "AIなし");
  currentAi.setAttribute("aria-label", aiTitle);
}

/**
 * 読み上げの最後に添える終了アナウンスを作ります。
 * 画面の見出しと同じく「選んだ処理方法」ではなく「実際に行ったこと」を伝えるため、
 * 入力が文字か画像か、要約・翻訳したか、AIを使ったかどうかから文言を組み立てます。
 * 例: 「AIによる画像翻訳を終了します。」「テキスト読み上げを終了します。」
 * AIを使っていないときは、そのことに触れずに何をしたかだけを伝えます。
 */
function buildFinishAnnouncement() {
  const isImage = inputSourceKind === "image";
  const aiMode = getTextAiMode();
  const usesAiResult = Boolean(aiResultInput.value.trim()) && aiMode && hasFreshAiResult(aiMode);
  // 画像を高精度OCR（AI）で読み取ったときも、AIを使ったこととして伝えます。
  const usesAi = Boolean(usesAiResult) || (isImage && ocrEngineUsed === "ai");

  const source = isImage ? "画像" : "テキスト";
  let action = "読み上げ";
  if (usesAiResult) action = aiMode === "translate" ? "翻訳" : "要約";

  return `${usesAi ? "AIによる" : ""}${source}${action}を終了します。`;
}

function startSpeaking() {
  const text = getTextToRead().trim();
  if (!text) {
    showError("入力テキストを入力してください。");
    textInput.focus();
    return;
  }

  // 前に作った音声は、新しく読み上げ始めた時点で保存できなくします。
  clearAiAudio();

  // AI音声（有料）がONのときは、Geminiで音声を作って再生します。
  if (isAiVoiceEnabled()) {
    startAiSpeaking(text).catch(handleAiPlaybackFailure);
    return;
  }

  // 前の読み上げがブラウザ内部で一時停止のまま残っていると、次のspeakが始まりません。
  // cancelの前にresumeして、その状態を確実に解除します。
  synthesis.resume();
  synthesis.cancel();
  sessionId += 1;
  const realChunks = splitText(text);
  realChunkCount = realChunks.length;
  // 最後に終了アナウンスを疑似チャンクとして追加し、読み上げ完了後にひと言添えてから閉じます。
  chunks = [...realChunks, buildFinishAnnouncement()];
  currentChunkIndex = 0;
  currentChunkOffset = 0;
  recoveryOffset = -1;
  skipAttempts = 0;
  failureStreak = 0;
  startRetryCount = 0;
  hasUtteranceStarted = false;
  isWaitingForStart = false;
  hasSpokenAnything = false;
  isReading = true;
  isPaused = false;
  // 実際に何をして読み上げているかを、見出しの右側へ表示します。
  updateCurrentChips();
  updateControls("speaking");
  startPlaybackTimers();
  speakCurrentChunk(sessionId);
}

// speechSynthesisのpause/resumeはブラウザによって再開に失敗することがあるため使用せず、
// 一時停止時は現在位置を記録して読み上げをcancelし、再開時はその続きから新しい発話を始めます。
function togglePause() {
  if (!isReading) return;

  // AI音声は、作った音声ファイルを鳴らしているだけなので、そのまま止めて再開できます。
  if (isAiPlayback) {
    isPaused = !isPaused;
    updateControls(isPaused ? "paused" : "speaking");
    if (isPaused) audioPlayer.pause();
    else playAudioPlayer();
    return;
  }

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
  startRetryCount = 0;
  stopPlaybackTimers();
  // 一時停止のまま解除すると、その状態がブラウザ側に残ることがあります。
  synthesis.resume();
  synthesis.cancel();
  stopAiPlayback();
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
  clearAiResult();
  clearAiAudio();
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

// 画面の折り返しで入った改行を、続きの文としてつなぎ直すための設定です。
// 文の終わりの記号で終わる行のあとと、次の行が続きに見えない場合は、改行をそのまま残します。
const SENTENCE_END_PATTERN = /[。．.！!？?：:；;」』】〉》〕］）)]$/;
// 行のはじめが日本語・小文字の英字・閉じ括弧・句読点なら、前の行からの続きとみなします。
// 大文字や数字で始まる行は、一覧の項目や見出しであることが多いため続きとみなしません。
const CONTINUATION_START_PATTERN = /^[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}ー々〆a-z、。，．」』）)]/u;
const LIST_START_PATTERN = /^(?:[-–—*+•・●○◆■□▲▼※＊]|\d{1,3}[.．)）、]|[(（]\d{1,3}[)）])/;
// 見出しのような短い行は、折り返しではないとみなして改行を残します。
const WRAPPED_LINE_MIN_LENGTH = 12;
// 読点で終わる行は文の途中なので、長さにかかわらず次の行が続きます。
const CONTINUING_END_PATTERN = /[、，,]$/;
// 折り返しで入った改行は、行が表示の幅いっぱいまで届いたところに入ります。
// いちばん長い行を表示の幅とみなし、そこに近い長さの行だけを「続きがある行」とみなします。
// これで、本文と同じくらいの長さでも幅に届かない見出しの改行を残せます。
const WRAPPED_LINE_WIDTH_RATIO = 0.9;

// 行の見た目の幅を測ります。英数字・記号は日本語の文字の半分の幅として数えます。
function measureTextWidth(line) {
  return Array.from(line).reduce((width, character) => width + (/[\u0020-\u007E\uFF61-\uFF9F]/.test(character) ? 0.5 : 1), 0);
}

/**
 * 画面の折り返し位置に入った改行を取り除き、続きの文をつなぎ直します。
 * PDFからコピーした文章やOCRで読み取った文章は、表示の幅で改行されているため、
 * そのままでは「〜便利な仕」「組みでも〜」のように語の途中で読み上げが切れます。
 * 文の終わりの記号で終わっていない行には続きの行がつながっているとみなし、その改行を取り除きます。
 * 箇条書き・一覧の項目・見出しのような行の改行は、段落の区切りとして残します。
 * OCRは1つの文の途中にも空行を入れるため、既定では空行をまたいでもつなぎます。
 * 貼り付けた文章の空行は段落の区切りなので、joinAcrossEmptyLinesをfalseにしてつなぎません。
 */
function joinWrappedLines(text, { joinAcrossEmptyLines = true } = {}) {
  const lines = text.split("\n").map((line) => line.trim());
  // 折り返しの幅は文章ごとに違うため、いちばん長い行の幅から求めます。
  const wrapWidth = Math.max(...lines.map(measureTextWidth), 0) * WRAPPED_LINE_WIDTH_RATIO;
  const joinedLines = [];
  // 空行はこのあとの整形でどのみち取り除かれるため、区切りとして見るかどうかだけを覚えておきます。
  let hasEmptyLineBefore = false;

  lines.forEach((line) => {
    if (line === "") {
      hasEmptyLineBefore = true;
      return;
    }

    // つなぎ先は、すでにつないだあとの行です。折り返しが続く限り1行にまとめます。
    const previousLine = joinedLines[joinedLines.length - 1] ?? "";
    // 読点で終わる行は文の途中なので、幅に届いていなくても続きとみなします。
    const reachesWrapWidth = CONTINUING_END_PATTERN.test(previousLine)
      || measureTextWidth(previousLine) >= wrapWidth;
    const continuesPreviousLine = joinedLines.length > 0
      && (joinAcrossEmptyLines || !hasEmptyLineBefore)
      && Array.from(previousLine).length >= WRAPPED_LINE_MIN_LENGTH
      && reachesWrapWidth
      && !SENTENCE_END_PATTERN.test(previousLine)
      && CONTINUATION_START_PATTERN.test(line)
      && !LIST_START_PATTERN.test(line);
    hasEmptyLineBefore = false;

    if (!continuesPreviousLine) {
      joinedLines.push(line);
      return;
    }

    // 英単語どうしは空白を入れ、日本語はそのままつなぎます。
    const needsSpace = /[A-Za-z0-9]$/.test(previousLine) && /^[a-z0-9]/.test(line);
    joinedLines[joinedLines.length - 1] = previousLine + (needsSpace ? " " : "") + line;
  });

  return joinedLines.join("\n");
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

// 貼り付けた文章とクリップボードから取り込んだ文章を、そのまま読み上げられる形に整えます。
// PDFなどからコピーした文章は表示の幅で改行されているため、その改行をつなぎ直してから整形します。
function cleanPastedText(text) {
  return sanitizePastedText(joinWrappedLines(text, { joinAcrossEmptyLines: false }));
}

// コピーできたことを知らせる表示は、少しの間だけ出して元へ戻します。
const COPY_NOTICE_DURATION = 2500;
const COPY_BUTTON_LABEL = '<span aria-hidden="true">📄</span> コピー';
const COPIED_BUTTON_LABEL = '<span aria-hidden="true">✓</span> コピーしました';

let copyNoticeTimerId = 0;

/**
 * コピーの結果を案内表示とボタンの見た目で知らせ、少しあとに元の表示へ戻します。
 */
function showCopyResult(message, isCopied) {
  window.clearTimeout(copyNoticeTimerId);

  if (isCopied) {
    statusText.classList.remove("error");
    statusText.textContent = message;
    copyButton.innerHTML = COPIED_BUTTON_LABEL;
    copyButton.classList.add("is-copied");
  } else {
    showError(message);
  }

  copyNoticeTimerId = window.setTimeout(() => {
    copyButton.innerHTML = COPY_BUTTON_LABEL;
    copyButton.classList.remove("is-copied");
    if (isReading) updateControls(isPaused ? "paused" : "speaking");
    else updateControls("idle");
  }, COPY_NOTICE_DURATION);
}

/**
 * 入力欄の文章をすべてクリップボードへコピーします。
 * 要約など、読み上げ以外の用途へ文章をそのまま渡せるようにするためのものです。
 * Clipboard APIが使えない環境では、入力欄を選択する昔ながらの方法でコピーします。
 */
async function copyTextToClipboard(sourceInput = textInput) {
  const text = sourceInput.value;

  if (!text.trim()) {
    showCopyResult("コピーする文章がありません。", false);
    return;
  }

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
    } else {
      sourceInput.select();
      const copied = document.execCommand("copy");
      sourceInput.setSelectionRange(text.length, text.length);
      if (!copied) throw new Error("execCommandでコピーできませんでした。");
    }

    showCopyResult(`${Array.from(text).length.toLocaleString("ja-JP")}文字をコピーしました。`, true);
  } catch (error) {
    console.warn("コピーに失敗しました。", error);
    showCopyResult("コピーできませんでした。入力欄を選択してCtrl+Cでコピーしてください。", false);
  }
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
    const { text: clipboardText, image: clipboardImage } = await readClipboardContent();

    // 画像がコピーされている場合は、文字を読み取ってからそのまま読み上げます。
    if (clipboardImage) {
      await runOcr(clipboardImage, true);
      return;
    }

    const sanitizedText = cleanPastedText(clipboardText);
    if (!sanitizedText.trim()) {
      showError("絵文字と空行を除くと、読み上げ可能な文章がありません。");
      return;
    }

    textInput.value = sanitizedText;
    markInputSource("text");
    updateCharacterCount();
    await startReading();
  } catch (error) {
    console.warn("クリップボードの読み取りに失敗しました。", error);
    const securityHint = window.isSecureContext
      ? "ブラウザのクリップボード権限を許可してください。"
      : "許可確認なしで使うには、入力欄を選択してCtrl+Vで貼り付けてください。";
    showError(`クリップボードを読み込めませんでした。${securityHint}`);
    textInput.focus();
  } finally {
    clipboardButton.disabled = false;
    clipboardButton.innerHTML = '<span aria-hidden="true">📋</span> <span class="nowrap">クリップボードの文章・画像を</span><span class="nowrap">読み上げ</span>';
  }
}

// ===== クリップボードの画像から文字を読み取る（OCR） =====
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

// 貼り付けられたものから、最初の画像を取り出します。
function findImageFile(dataTransfer) {
  return Array.from(dataTransfer?.files || []).find((file) => file.type.startsWith("image/")) || null;
}

/**
 * クリップボードの内容を文章と画像のどちらでも受け取れるように読み取ります。
 * ブラウザによっては操作の直後しか読み取れないため、読み取りは1回にまとめます。
 * 文章も画像も入っている場合は、これまでどおり文章を優先します。
 * 画像に対応していないブラウザや読み取りに失敗した場合は、文章だけを読み取ります。
 */
async function readClipboardContent() {
  if (typeof navigator.clipboard?.read === "function") {
    try {
      const clipboardItems = await navigator.clipboard.read();
      let imageFile = null;

      for (const item of clipboardItems) {
        if (item.types.includes("text/plain")) {
          return { text: await (await item.getType("text/plain")).text(), image: null };
        }

        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (imageType && !imageFile) {
          const blob = await item.getType(imageType);
          imageFile = new File([blob], "clipboard-image", { type: blob.type });
        }
      }

      return { text: "", image: imageFile };
    } catch (error) {
      console.warn("クリップボードの画像を確認できませんでした。", error);
    }
  }

  return { text: await navigator.clipboard.readText(), image: null };
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
  return sanitizePastedText(joinWrappedLines(removeSpacesBetweenJapanese(text)));
}

// Tesseractで読み取ります。ブラウザの中だけで処理し、画像は外部へ送信しません。
async function recognizeWithTesseract(file) {
  showOcrProgress("準備中", 0);
  const tesseract = await loadTesseract();
  const result = await tesseract.recognize(file, OCR_LANGUAGE, { logger: handleOcrProgress });
  return result?.data?.text || "";
}

/**
 * 画像ファイルから文字を読み取り、入力欄へ入れます。
 * 「画像の読み取り方法」で選んでいるほうを使うため、貼り付けや
 * 「クリップボードの文章・画像を読み上げ」の1回の操作だけで読み取りまで進みます。
 * speakAfterOcrがtrueのときは、読み取りに続けてそのまま読み上げます。
 */
async function runOcr(file, speakAfterOcr = false) {
  // 連打しても複数回動かないよう、処理中は受け付けません。
  if (isOcrRunning) return;

  if (!file || !file.type.startsWith("image/")) {
    showError("画像を読み取れませんでした。もう一度コピーしてからお試しください。");
    return;
  }

  const useAi = usesAiOcr();

  isOcrRunning = true;
  setProcessModeEnabled(false);
  // 読み上げ中に文章を入れ替えないよう、先に読み上げを止めます。
  if (isReading) stopSpeaking();
  statusText.classList.remove("error");
  statusText.textContent = useAi ? "AIで文字を読み取っています…" : "画像から文字を読み取っています";

  try {
    const rawText = useAi ? await recognizeWithGeminiAndLogin(file) : await recognizeWithTesseract(file);
    const recognizedText = cleanOcrText(rawText);

    if (!recognizedText) {
      showError(useAi
        ? "AIが文字を読み取れませんでした。通常OCRをお試しください。"
        : "画像から文字を読み取れませんでした。明るく大きく写った画像でお試しください。");
      return;
    }

    textInput.value = recognizedText;
    // 画像から読み取った文章であることと、どちらのOCRを使ったかを覚えます。
    markInputSource("image", useAi ? "ai" : "free");
    updateCharacterCount();

    if (speakAfterOcr) {
      // 画像 → 読み取り → （選んでいれば）AIの処理 → 読み上げ、の順に進みます。
      await startReading();
      return;
    }

    // 読み上げまでは進めない場合も、読み上げモードを選んでいればAIの処理までは行います。
    const aiResult = await applyAiModeAfterOcr();
    if (aiResult === "failed") return;

    if (aiResult === "done") {
      statusText.textContent = "AIで処理しました。内容を確認して読み上げてください。";
    } else {
      statusText.textContent = useAi
        ? "AIで読み取りました。内容を確認して読み上げてください。"
        : "読み取りが完了しました。内容を直してから読み上げてください。";
    }
    // 携帯電話ではキーボードが出てしまうため、入力欄への移動はパソコンだけにします。
    if (!isMobileBrowser) textInput.focus();
  } catch (error) {
    console.warn("画像の読み取りに失敗しました。", error);
    showOcrFailure(error, useAi);
  } finally {
    isOcrRunning = false;
    setProcessModeEnabled(true);
    hideOcrProgress();
  }
}

// 失敗の理由に合わせて案内を出します。AI OCRのときは、見分けるための短い印も添えます。
function showOcrFailure(error, useAi) {
  if (error?.ocrMessage) {
    showAiOcrError(error.ocrMessage, error.ocrCode);
    return;
  }

  if (!useAi) {
    showError("画像の文字を読み取れませんでした。通信状況を確認して、もう一度お試しください。");
    return;
  }

  if (error?.name === "AbortError") {
    showAiOcrError("AI OCRが時間内に終わりませんでした。通常OCRをお試しください。", "AI-TIMEOUT-B");
    return;
  }

  showAiOcrError("AI OCRを利用できません。しばらくしてから再度お試しください。", "AI-NET-B");
}

// ===== AIの機能のパスワード認証 =====
// 料金が発生するAIの機能だけを守ります。読み上げと通常OCRは、これまでどおり認証なしで使えます。
// パスワードはサーバー側（/api/login）だけで確かめ、ブラウザには保存しません。
// 認証できると、書き換えられない引換券がHttpOnly Cookieで渡され、24時間ほど有効です。

const LOGIN_ENDPOINT = "/api/login";
const PASSWORD_SUBMIT_LABEL = "認証して利用";

let passwordResolve = null;

/**
 * パスワードの入力を求め、認証できたかどうかを返します。
 * 入力されたパスワードは送信したあとに消し、画面にも保存にも残しません。
 */
function requestPassword() {
  return new Promise((resolve) => {
    passwordResolve = resolve;
    passwordInput.value = "";
    passwordError.hidden = true;
    passwordDialog.showModal();
    passwordInput.focus();
  });
}

function closePasswordDialog(isAuthenticated) {
  const resolve = passwordResolve;
  passwordResolve = null;
  passwordInput.value = "";
  passwordDialog.close();
  if (resolve) resolve(isAuthenticated);
}

passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const password = passwordInput.value;
  if (!password) return;

  passwordSubmit.disabled = true;
  passwordSubmit.textContent = "確認中…";

  try {
    const response = await fetch(LOGIN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password }),
    });

    if (response.ok) {
      closePasswordDialog(true);
      return;
    }

    const result = await response.json().catch(() => null);
    passwordError.textContent = result?.message || "パスワードを確認できませんでした。";
    passwordError.hidden = false;
    passwordInput.value = "";
    passwordInput.focus();
  } catch (error) {
    console.warn("パスワードを確認できませんでした。", error);
    passwordError.textContent = "パスワードを確認できませんでした。通信状況を確認してください。";
    passwordError.hidden = false;
  } finally {
    passwordSubmit.disabled = false;
    passwordSubmit.textContent = PASSWORD_SUBMIT_LABEL;
  }
});

passwordCancel.addEventListener("click", () => closePasswordDialog(false));

// Escキーで閉じたときも、キャンセルと同じ扱いにします。
passwordDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closePasswordDialog(false);
});

// ===== AIで高精度OCR（Gemini API） =====
// Gemini APIのキーをブラウザへ置くと誰にでも読み取られてしまうため、
// ブラウザからは直接呼ばず、Vercel側の /api/ocr を経由して呼び出します。
// 料金がかかるため、「画像の読み取り方法」でAI OCRを選んでいるときだけ呼び出します。

const AI_OCR_ENDPOINT = "/api/ocr";
const AI_OCR_TIMEOUT_MS = 35000;
// Vercelへ送れる大きさには上限があるため、余裕をみた上限を決めています。
const AI_OCR_MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const AI_OCR_MAX_IMAGE_SIDE = 2000;
const AI_OCR_SUPPORTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
// 文字がつぶれないよう、画質は高いほうから順に試します。
const AI_OCR_JPEG_QUALITIES = [0.92, 0.8, 0.7];

// うまくいかないときにどこで止まったかを見分けられるよう、短い印を添えて表示します。
function showAiOcrError(message, code) {
  showError(code ? `${message}（${code}）` : message);
}

// 画面へそのまま出せる案内を持たせたエラーです。
function createOcrError(message, code) {
  const error = new Error(message);
  error.ocrMessage = message;
  error.ocrCode = code;
  return error;
}

function readImageAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("画像を読み込めませんでした。"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 大きすぎる画像や対応していない形式の画像を、送れる大きさのJPEGへ変換します。
 * 文字を読み取るための画像なので、縮めすぎないように長辺の上限だけを決めています。
 */
async function shrinkImageForAiOcr(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, AI_OCR_MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  for (const quality of AI_OCR_JPEG_QUALITIES) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= AI_OCR_MAX_UPLOAD_BYTES) return blob;
  }

  throw createOcrError("画像が大きすぎます。少し小さい画像でお試しください。", "AI-SIZE-B");
}

// そのまま送れる画像はそのまま、送れない画像だけ縮小して、Base64にして返します。
async function prepareImageForAiOcr(file) {
  const canSendAsIs = AI_OCR_SUPPORTED_TYPES.includes(file.type) && file.size <= AI_OCR_MAX_UPLOAD_BYTES;
  const image = canSendAsIs ? file : await shrinkImageForAiOcr(file);

  return {
    mimeType: canSendAsIs ? file.type : "image/jpeg",
    image: await readImageAsBase64(image),
  };
}

/**
 * AIの処理を実行します。パスワードが必要（401）だったときは入力を求め、
 * 認証できたらそのまま同じ内容でもう一度実行します。
 */
async function withPasswordRetry(run) {
  try {
    return await run();
  } catch (error) {
    // 401で終わる印（AI-401・TTS-401）は、パスワードが必要という意味です。
    if (!/-401$/.test(error?.ocrCode || "")) throw error;

    const isAuthenticated = await requestPassword();
    if (!isAuthenticated) {
      throw createOcrError("AIの機能を使うには、パスワードの入力が必要です。", "AI-401");
    }

    return run();
  }
}

function recognizeWithGeminiAndLogin(file) {
  return withPasswordRetry(() => recognizeWithGemini(file));
}

// Vercel側の /api/ocr を経由して、Geminiが読み取った文章を受け取ります。
async function recognizeWithGemini(file) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), AI_OCR_TIMEOUT_MS);

  try {
    const payload = await prepareImageForAiOcr(file);
    const response = await fetch(AI_OCR_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 認証の引換券（Cookie）を一緒に送ります。
      credentials: "same-origin",
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const result = await response.json().catch(() => null);

    // Vercel側の処理が見つからない・落ちている場合は、JSONではない応答が返ります。
    if (!result) {
      if (response.status === 404) {
        throw createOcrError("AI OCRの機能が見つかりません。デプロイが終わっているか確認してください。", "AI-HTTP404");
      }
      if (response.status === 413) {
        throw createOcrError("画像が大きすぎます。少し小さい画像でお試しください。", "AI-HTTP413");
      }
      throw createOcrError("AI OCRの応答を読み取れませんでした。しばらくしてから再度お試しください。", `AI-HTTP${response.status}`);
    }

    if (!response.ok || !result.text) {
      throw createOcrError(result.message || "AI OCRに失敗しました。通常OCRをお試しください。", result.code);
    }

    // 読み取った文章だけを受け取ります。
    return result.text;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

// ===== 処理方法（そのまま / 高精度OCR / 翻訳 / 要約） =====
// 画像の読み取り方と、読み上げる前のAI処理を、1つの選択で決めます。
// 高精度OCR・翻訳・要約はGeminiを使うため、同じパスワード認証が必要です。

const AI_TEXT_ENDPOINT = "/api/ai";
const AI_TEXT_TIMEOUT_MS = 45000;
const PROCESS_MODE_STORAGE_KEY = "yomiage-process-mode";
const PROCESS_MODES = ["plain", "ai-ocr", "summarize", "translate"];
const TRANSLATE_LANGUAGE_STORAGE_KEY = "yomiage-translate-language";

// AIの結果がどの文章から作られたかを覚えておき、同じ文章を二度送らないようにします。
let aiResultSource = "";
let aiResultMode = "";
let aiResultLanguage = "";

function getProcessMode() {
  const selected = document.querySelector('input[name="process-mode"]:checked');
  return selected && PROCESS_MODES.includes(selected.value) ? selected.value : "plain";
}

// 画像をGeminiで読み取るのは「高精度OCRで読み上げ」を選んでいるときだけです。
// マウスを重ねたときや読み上げソフト向けの、省略しない処理方法の名前です。
function getProcessModeFullLabel() {
  const selected = document.querySelector('input[name="process-mode"]:checked');
  const title = selected?.closest(".process-option")?.querySelector(".process-option-title");
  return title ? title.textContent.trim() : "";
}

/**
 * いま入力欄にある文章が「文字として入れたもの」か「画像から読み取ったもの」かを覚えます。
 * 選んだ処理方法ではなく、実際に行ったことを画面へ出すためのものです。
 * 例えば「高精度OCRで読み上げ」を選んでいても、文字を入力したときはAIを使いません。
 */
let inputSourceKind = "text";
let ocrEngineUsed = "";

function markInputSource(kind, ocrEngine = "") {
  inputSourceKind = kind;
  ocrEngineUsed = ocrEngine;
}

function usesAiOcr() {
  return getProcessMode() === "ai-ocr";
}

// 読み上げる前に文章をAIで処理するかどうかを返します（しない場合は空文字）。
function getTextAiMode() {
  const mode = getProcessMode();
  return mode === "translate" || mode === "summarize" ? mode : "";
}

// 処理中は、途中で方法を変えられないようにします。
function setProcessModeEnabled(isEnabled) {
  [...processModeInputs, ...quickModeInputs].forEach((input) => {
    input.disabled = !isEnabled;
  });
  translateLanguage.disabled = !isEnabled;
}

// 一番上の簡易選択と、下の「処理方法」は、どちらを操作しても同じ内容になるようにします。
function syncProcessModeInputs(mode) {
  processModeInputs.forEach((input) => {
    input.checked = input.value === mode;
  });
  quickModeInputs.forEach((input) => {
    input.checked = input.value === mode;
  });
}

// 翻訳先の言語は「翻訳して読み上げ」を選んでいるときだけ表示します。
function updateTranslateLanguageField() {
  translateLanguageField.hidden = getProcessMode() !== "translate";
}

// 選んだ内容は、次に使うときのためにブラウザへ保存します。
// 保存できない設定のブラウザ（プライベート閲覧など）でも、そのまま使えるようにします。
function saveProcessSettings() {
  try {
    localStorage.setItem(PROCESS_MODE_STORAGE_KEY, getProcessMode());
    localStorage.setItem(TRANSLATE_LANGUAGE_STORAGE_KEY, translateLanguage.value);
  } catch (error) {
    console.warn("処理方法を保存できませんでした。", error);
  }
}

function restoreProcessSettings() {
  try {
    const savedMode = localStorage.getItem(PROCESS_MODE_STORAGE_KEY);
    if (savedMode && PROCESS_MODES.includes(savedMode)) syncProcessModeInputs(savedMode);

    const savedLanguage = localStorage.getItem(TRANSLATE_LANGUAGE_STORAGE_KEY);
    if (savedLanguage && [...translateLanguage.options].some((option) => option.value === savedLanguage)) {
      translateLanguage.value = savedLanguage;
    }
  } catch (error) {
    console.warn("保存した処理方法を読み込めませんでした。", error);
  }

  updateTranslateLanguageField();
}

// 一番上の簡易選択も、下の「処理方法」も、切り替えるのは設定だけです。
// 読み上げは「読み上げ」のボタンを押したときだけ始めます。
[...processModeInputs, ...quickModeInputs].forEach((input) => {
  input.addEventListener("change", () => {
    syncProcessModeInputs(input.value);
    updateTranslateLanguageField();
    saveProcessSettings();
  });
});

translateLanguage.addEventListener("change", saveProcessSettings);

restoreProcessSettings();

// AIの結果を別の欄に入れることで、元の文章は入力欄にそのまま残します。
function updateAiResultCount() {
  aiResultCount.textContent = `${Array.from(aiResultInput.value).length.toLocaleString("ja-JP")}文字`;
}

const AI_RESULT_HELP = "読み上げるのは、こちらの文章です。「消す」を押すと、上の文章を読み上げます。";

function showAiResult(text, mode, isUnchanged = false) {
  const kind = mode === "translate"
    ? `${translateLanguage.selectedOptions[0].textContent}に翻訳`
    : "日本語に要約";

  aiResultInput.value = text;
  // AIが原文をそのまま返したときは、処理されていないことが分かるようにします。
  aiResultKind.textContent = isUnchanged ? `${kind}（変わりませんでした）` : kind;
  aiResultKind.classList.toggle("ai-result-kind-warning", isUnchanged);
  aiResultHelp.textContent = isUnchanged
    ? `AIは文章を変えずに返しました。すでに${mode === "translate" ? translateLanguage.selectedOptions[0].textContent + "の文章" : "短い文章"}か、読み取った文字が崩れている可能性があります。${AI_RESULT_HELP}`
    : AI_RESULT_HELP;
  aiResultSection.hidden = false;
  updateAiResultCount();
}

// AIの結果を消して、元の文章を読み上げる状態へ戻します。
function clearAiResult() {
  aiResultInput.value = "";
  aiResultSection.hidden = true;
  aiResultSource = "";
  updateAiResultCount();
}

aiResultInput.addEventListener("input", () => {
  updateAiResultCount();
  // 手で直した文章は、そのまま読み上げます（もう一度AIへ送りません）。
  aiResultSource = textInput.value;
});

aiResultCopy.addEventListener("click", () => copyTextToClipboard(aiResultInput));

aiResultClear.addEventListener("click", () => {
  if (isReading) stopSpeaking();
  clearAiResult();
  statusText.classList.remove("error");
  statusText.textContent = "AIの結果を消しました。上の文章を読み上げます。";
});

// Vercel側の /api/ai を経由して、Geminiが処理した文章を受け取ります。
async function requestAiText(mode, text) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), AI_TEXT_TIMEOUT_MS);

  try {
    const response = await fetch(AI_TEXT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 認証の引換券（Cookie）を一緒に送ります。
      credentials: "same-origin",
      body: JSON.stringify(mode === "translate"
        ? { action: "translate", text, targetLanguage: translateLanguage.value }
        : { action: "summarize", text }),
      signal: controller.signal,
    });

    const result = await response.json().catch(() => null);

    if (!result) {
      if (response.status === 404) {
        throw createOcrError("AIの機能が見つかりません。デプロイが終わっているか確認してください。", "AI-HTTP404");
      }
      throw createOcrError("AIの応答を読み取れませんでした。しばらくしてから再度お試しください。", `AI-HTTP${response.status}`);
    }

    if (!response.ok || !result.text) {
      throw createOcrError(result.message || "AIの処理に失敗しました。しばらくしてから再度お試しください。", result.code);
    }

    // unchangedは、AIが原文をそのまま返したことを示す印です。
    return { text: result.text, unchanged: Boolean(result.unchanged) };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

/**
 * 選んだ読み上げモードに合わせて、読み上げる前に文章をAIで処理します。
 * 結果は「AIの結果」の欄へ入れ、元の文章は入力欄にそのまま残します。
 * 処理できたらtrueを返します。失敗したりパスワードを入れなかった場合はfalseを返します。
 */
async function applyAiMode(mode) {
  const sourceText = textInput.value;

  setProcessModeEnabled(false);
  if (isReading) stopSpeaking();
  statusText.classList.remove("error");
  statusText.textContent = mode === "translate" ? "AIで翻訳しています…" : "AIで要約しています…";

  try {
    const processed = await withPasswordRetry(() => requestAiText(mode, sourceText));
    const cleanedText = sanitizePastedText(processed.text);

    if (!cleanedText) {
      showError("AIが文章を返しませんでした。もう一度お試しください。");
      return false;
    }

    showAiResult(cleanedText, mode, processed.unchanged);
    // 同じ文章・同じモードのときは、二度AIへ送らないように覚えておきます。
    aiResultSource = sourceText;
    aiResultMode = mode;
    aiResultLanguage = translateLanguage.value;
    return true;
  } catch (error) {
    console.warn("AIの処理に失敗しました。", error);
    if (error?.ocrMessage) showAiOcrError(error.ocrMessage, error.ocrCode);
    else if (error?.name === "AbortError") showAiOcrError("AIの処理が時間内に終わりませんでした。短い文章でお試しください。", "AI-TIMEOUT-B");
    else showAiOcrError("AIの機能を利用できません。しばらくしてから再度お試しください。", "AI-NET-B");
    return false;
  } finally {
    setProcessModeEnabled(true);
  }
}

// すでに同じ文章を同じ条件で処理しているかどうかを調べます。
function hasFreshAiResult(mode) {
  return Boolean(aiResultInput.value.trim())
    && aiResultSource === textInput.value
    && aiResultMode === mode
    && (mode !== "translate" || aiResultLanguage === translateLanguage.value);
}

// 画像を読み取ったあと、読み上げモードを選んでいれば、続けてAIの処理まで進めます。
async function applyAiModeAfterOcr() {
  const mode = getTextAiMode();
  if (!mode) return "skipped";
  return (await applyAiMode(mode)) ? "done" : "failed";
}

/**
 * 読み上げの入口です。「そのまま読み上げ」ならこれまでどおりすぐ読み上げ、
 * 翻訳・要約を選んでいるときは、先にAIで処理してから読み上げます。
 */
async function startReading() {
  const mode = getTextAiMode();

  // 文章がないときや、すでに同じ条件でAIが処理しているときは、そのまま読み上げます。
  if (!mode || !textInput.value.trim() || hasFreshAiResult(mode)) {
    startSpeaking();
    return;
  }

  const isProcessed = await applyAiMode(mode);
  if (isProcessed) startSpeaking();
}

// ===== AI音声（Gemini）で読み上げる =====
// ブラウザの音声（無料）とは別に、Geminiに音声を作らせて読み上げます。
// 料金がかかるため、音声の選択で選んだときだけ使い、パスワードの認証も必要です。
// 作った音声は、そのままWAVファイルとして保存できます。

const AI_TTS_ENDPOINT = "/api/tts";
// 音声を作るのには時間がかかるため、長めに待ちます（api/tts.js の maxDuration より長くします）。
const AI_TTS_TIMEOUT_MS = 65000;
// 1回で作る文章の長さです。短く区切るほど、最初の音が出るまでが早くなり、時間切れも起きにくくなります。
// api/tts.js の MAX_TEXT_LENGTH より短くしてください。
const AI_TTS_CHUNK_LENGTH = 120;
// Geminiが返す音声の形式です（16ビット・モノラル）。実際の値は返事から読み取ります。
const AI_TTS_DEFAULT_SAMPLE_RATE = 24000;
const AI_TTS_BITS_PER_SAMPLE = 16;
// Gemini側が混み合っている（429）ときに、待ってからやり直す回数と、既定の待ち時間です。
const AI_TTS_BUSY_RETRY_DELAYS_MS = [8000, 20000];

// 同じ文章・同じ声をもう一度読み上げるときに、作り直して料金がかからないようにします。
// 音声は大きいため、覚えておく量に上限を決めて、古いものから忘れます。
const AI_SPEECH_CACHE_MAX_BYTES = 32 * 1024 * 1024;

// 選べるAI音声です。増やすときは、api/tts.js の ALLOWED_VOICES にも追加してください。
// 先頭の声が初期値になります。
const AI_VOICES = [
  { id: "Aoede", label: "Aoede（軽やかな声）" },
  { id: "Kore", label: "Kore（落ち着いた声）" },
  { id: "Puck", label: "Puck（明るい声）" },
  { id: "Charon", label: "Charon（説明に向いた声）" },
  { id: "Leda", label: "Leda（若々しい声）" },
  { id: "Achird", label: "Achird（親しみやすい声）" },
  { id: "Vindemiatrix", label: "Vindemiatrix（やさしい声）" },
  { id: "Sulafat", label: "Sulafat（あたたかい声）" },
];

// 読み上げ速度の初期値です。AI音声はもともと自然な速さで話すため、1.0倍から始めます。
const BROWSER_DEFAULT_RATE = 2;
const AI_DEFAULT_RATE = 1;

const AI_VOICE_NOTE_ON = "✨ この声で読み上げます。料金がかかり、パスワードの入力が必要です。作った音声は「音声を保存」からWAVで保存できます。";
const AI_VOICE_NOTE_OFF = "上の「✨ AI音声で読み上げ」をONにすると、この声で読み上げます（有料）。OFFのあいだは、ブラウザの音声（無料）で読み上げます。";

const audioPlayer = new Audio();
audioPlayer.preload = "auto";

// いまの読み上げがAI音声かどうかと、そのときだけ使う状態です。
let isAiPlayback = false;
let aiVoiceUsed = "";
let aiAudioUrl = "";
// 保存用に、作った音声（PCM）を読み上げた順にためます。
let aiAudioParts = [];
let aiSampleRate = AI_TTS_DEFAULT_SAMPLE_RATE;
let isAudioUnlocked = false;
const aiSpeechCache = new Map();

// 読み上げ速度は、ブラウザの音声とAI音声で別々に覚えておきます。
let browserRate = BROWSER_DEFAULT_RATE;
let aiRate = AI_DEFAULT_RATE;

// 画面いちばん上の切り替えがONのときだけ、AI音声で読み上げます。
function isAiVoiceEnabled() {
  return aiVoiceToggle.checked;
}

function getSelectedAiVoice() {
  return aiVoiceSelect.value || AI_VOICES[0].id;
}

// 選べるAI音声を、ブラウザの音声とは別の選択として並べます。
function loadAiVoices() {
  aiVoiceSelect.replaceChildren();
  AI_VOICES.forEach((voice) => {
    aiVoiceSelect.add(new Option(voice.label, voice.id));
  });
  aiVoiceSelect.value = AI_VOICES[0].id;
}

// AI音声を使うかどうかで、案内の文言と色を変えます。
function updateVoiceNote() {
  const isAiVoice = isAiVoiceEnabled();
  voiceNote.textContent = isAiVoice ? AI_VOICE_NOTE_ON : AI_VOICE_NOTE_OFF;
  voiceNote.classList.toggle("is-ai", isAiVoice);
}

// 読み上げ速度を、表示と読み上げソフト向けの案内ごと入れ替えます。
function setRate(rate) {
  rateInput.value = String(rate);
  const label = `${Number(rate).toFixed(1)}倍`;
  rateOutput.textContent = label;
  rateInput.setAttribute("aria-valuetext", label);
}

/**
 * AI音声を使うかどうかを切り替えます。
 * 読み上げ速度は、ブラウザの音声とAI音声で別々に覚えておき、切り替えに合わせて戻します。
 */
function handleAiVoiceToggle() {
  if (isAiVoiceEnabled()) {
    browserRate = Number(rateInput.value) || BROWSER_DEFAULT_RATE;
    setRate(aiRate);
  } else {
    aiRate = Number(rateInput.value) || AI_DEFAULT_RATE;
    setRate(browserRate);
  }

  updateVoiceNote();
}

function getPlaybackRate() {
  const rate = Number(rateInput.value) || 1;
  return Math.min(4, Math.max(0.5, rate));
}

/**
 * iPhoneなどでは、画面を触ったあとでないと音を鳴らせません。
 * 最初の操作のときに無音を一度だけ鳴らして、あとから音を出せるようにします。
 */
function unlockAudioPlayback() {
  if (isAudioUnlocked) return;
  isAudioUnlocked = true;

  try {
    const silentUrl = URL.createObjectURL(buildWavBlob([new Uint8Array(480)], AI_TTS_DEFAULT_SAMPLE_RATE));
    audioPlayer.src = silentUrl;
    const played = audioPlayer.play();
    if (played?.catch) played.catch(() => {});
    window.setTimeout(() => URL.revokeObjectURL(silentUrl), 5000);
  } catch (error) {
    console.warn("音声の準備ができませんでした。", error);
  }
}

document.addEventListener("pointerdown", unlockAudioPlayback, { once: true });
document.addEventListener("keydown", unlockAudioPlayback, { once: true });

// ブラウザの音声エンジンも、同じく最初の操作のときに起こしておきます。
// 読み上げボタンの操作では行いません（直後のcancelが本来の発話を打ち消すため）。
["pointerdown", "keydown"].forEach((eventName) => {
  document.addEventListener(eventName, (event) => {
    if (event.target instanceof Element && event.target.closest("#speak-button, #clipboard-button")) return;
    primeSpeechSynthesis();
  }, { capture: true, passive: true });
});

function playAudioPlayer() {
  const played = audioPlayer.play();
  if (!played?.catch) return;

  played.catch((error) => {
    if (!isReading || !isAiPlayback) return;
    console.warn("AI音声を再生できませんでした。", error);
    showError("音声を再生できませんでした。画面をタップしてから、もう一度お試しください。");
  });
}

/**
 * AI音声で読み上げます。
 * 文章を短く区切り、1つ目ができたらすぐ再生を始め、次の音声は再生中に作ります。
 */
async function startAiSpeaking(text) {
  const realChunks = splitText(text, AI_TTS_CHUNK_LENGTH);
  if (realChunks.length === 0) {
    showError("入力テキストを入力してください。");
    return;
  }

  synthesis.cancel();
  // ブラウザの音声用の見張り（停止検知）は、AI音声では使わないため止めます。
  stopPlaybackTimers();
  stopAiPlayback();
  sessionId += 1;
  const activeSessionId = sessionId;

  realChunkCount = realChunks.length;
  currentChunkIndex = 0;
  currentChunkOffset = 0;
  isReading = true;
  isPaused = false;
  isAiPlayback = true;
  hasSpokenAnything = false;
  aiAudioParts = [];
  aiVoiceUsed = getSelectedAiVoice();
  // AI音声では、最後のひと言（終了アナウンス）は読み上げません。
  chunks = realChunks;

  updateCurrentChips();
  updateControls("speaking");

  await playAiChunk(activeSessionId, 0);
}

// 1つ分の音声を作って再生し、終わったら次へ進みます。
async function playAiChunk(activeSessionId, index) {
  if (!isReading || activeSessionId !== sessionId) return;

  if (index >= chunks.length) {
    finishAiPlayback();
    return;
  }

  currentChunkIndex = index;
  const chunkText = chunks[index];
  renderCurrentText(chunkText);
  renderProgressDots(index + 1, realChunkCount);

  // 音声を作っているあいだも、何をしているかが分かるようにします。
  if (!isPaused) {
    statusText.classList.remove("error");
    statusText.textContent = realChunkCount > 1
      ? `AI音声を作っています…（${index + 1} / ${realChunkCount}）`
      : "AI音声を作っています…";
  }

  let speech = null;
  try {
    speech = await fetchAiSpeech(chunkText);
  } catch (error) {
    if (!isReading || activeSessionId !== sessionId) return;
    console.warn("AI音声を作れませんでした。", error);
    stopSpeaking(false);
    showAiOcrError(
      error?.ocrMessage || "AI音声を作れませんでした。しばらくしてから再度お試しください。",
      error?.ocrCode || (error?.name === "AbortError" ? "TTS-TIMEOUT-B" : "TTS-NET-B"),
    );
    return;
  }

  if (!isReading || activeSessionId !== sessionId) return;

  // 保存できるよう、読み上げた音声を順番にためます。
  aiAudioParts.push(speech.pcm);
  aiSampleRate = speech.sampleRate;
  updateDownloadButton();

  // 次の音声は、いまの音声を流しているあいだに作っておきます。
  if (index + 1 < chunks.length) {
    fetchAiSpeech(chunks[index + 1]).catch(() => {});
  }

  if (aiAudioUrl) URL.revokeObjectURL(aiAudioUrl);
  aiAudioUrl = URL.createObjectURL(buildWavBlob([speech.pcm], speech.sampleRate));

  audioPlayer.onended = () => {
    if (!isReading || activeSessionId !== sessionId) return;
    hasSpokenAnything = true;
    playAiChunk(activeSessionId, index + 1).catch(handleAiPlaybackFailure);
  };
  audioPlayer.onerror = () => {
    if (!isReading || activeSessionId !== sessionId) return;
    console.warn("AI音声を再生できませんでした。");
    stopSpeaking(false);
    showError("AI音声を再生できませんでした。もう一度お試しください。");
  };

  audioPlayer.src = aiAudioUrl;
  audioPlayer.playbackRate = getPlaybackRate();

  // 一時停止しているあいだに音声ができたときは、再開されるまで待ちます。
  if (isPaused) return;

  // ポップアップは、音が鳴り始めるところで出します。
  currentSection.hidden = false;
  updateControls("speaking");
  playAudioPlayer();
}

// 思わぬ失敗で読み上げが止まったままにならないよう、まとめて受け止めます。
function handleAiPlaybackFailure(error) {
  console.warn("AI音声で読み上げられませんでした。", error);
  stopSpeaking(false);
  showError("AI音声で読み上げられませんでした。もう一度お試しください。");
}

function finishAiPlayback() {
  isReading = false;
  isPaused = false;
  isAiPlayback = false;
  currentSection.hidden = true;
  if (hasSpokenAnything) updateControls("finished");
  else showError("読み上げを開始できませんでした。もう一度お試しください。");
}

// 再生を止めて、音声の後始末をします。作った音声（保存用）はそのまま残します。
function stopAiPlayback() {
  isAiPlayback = false;
  audioPlayer.onended = null;
  audioPlayer.onerror = null;
  audioPlayer.pause();

  if (aiAudioUrl) {
    URL.revokeObjectURL(aiAudioUrl);
    aiAudioUrl = "";
  }
}

/**
 * 1つ分の音声をGeminiへ作ってもらいます。
 * 同じ文章・同じ声のときは、作り直さずに前の音声を使います（料金がかからないようにするため）。
 */
function fetchAiSpeech(text) {
  const key = `${aiVoiceUsed}|${text}`;
  const cached = aiSpeechCache.get(key);
  if (cached) return cached.request;

  const entry = { request: withPasswordRetry(() => requestAiSpeechWithRetry(text, aiVoiceUsed)), bytes: 0 };
  aiSpeechCache.set(key, entry);

  entry.request.then((speech) => {
    entry.bytes = speech.pcm.length;
    trimAiSpeechCache();
  }).catch(() => {
    // 失敗した音声は覚えません（次にもう一度試せるようにするため）。
    aiSpeechCache.delete(key);
  });

  return entry.request;
}

// 覚えている音声が多くなりすぎないよう、古いものから忘れます。
function trimAiSpeechCache() {
  let total = 0;
  aiSpeechCache.forEach((entry) => {
    total += entry.bytes;
  });

  for (const [key, entry] of aiSpeechCache) {
    if (total <= AI_SPEECH_CACHE_MAX_BYTES) break;
    total -= entry.bytes;
    aiSpeechCache.delete(key);
  }
}

/**
 * Gemini側が混み合っている（TTS-G429）ときは、少し待ってからやり直します。
 * 無料枠では1分あたりに作れる回数が決まっているため、待てば続きを作れることが多いからです。
 * 待つ時間は、Geminiが教えてくれた秒数を優先して使います。
 */
async function requestAiSpeechWithRetry(text, voice) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestAiSpeech(text, voice);
    } catch (error) {
      const defaultDelay = AI_TTS_BUSY_RETRY_DELAYS_MS[attempt];
      if (error?.ocrCode !== "TTS-G429" || !defaultDelay) throw error;

      const waitMs = Math.min(Math.max(error.retryAfterMs || defaultDelay, 3000), 60000);
      showBusyNotice(waitMs);
      await new Promise((resolve) => window.setTimeout(resolve, waitMs));
    }
  }
}

// 混み合っているあいだ、待っていることが分かるようにします。
// 止めたあとに案内が出てしまわないよう、読み上げているあいだだけ出します。
function showBusyNotice(waitMs) {
  if (!isReading || !isAiPlayback) return;
  statusText.classList.remove("error");
  statusText.textContent = `AI音声が混み合っています。${Math.ceil(waitMs / 1000)}秒待ってから続きを作ります…`;
}

// Vercel側の /api/tts を経由して、Geminiが作った音声を受け取ります。
async function requestAiSpeech(text, voice) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), AI_TTS_TIMEOUT_MS);

  try {
    const response = await fetch(AI_TTS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 認証の引換券（Cookie）を一緒に送ります。
      credentials: "same-origin",
      body: JSON.stringify({ text, voice }),
      signal: controller.signal,
    });

    const result = await response.json().catch(() => null);

    if (!result) {
      if (response.status === 404) {
        throw createOcrError("AI音声の機能が見つかりません。デプロイが終わっているか確認してください。", "TTS-HTTP404");
      }
      throw createOcrError("AI音声の応答を読み取れませんでした。しばらくしてから再度お試しください。", `TTS-HTTP${response.status}`);
    }

    if (!response.ok || !result.audio) {
      const error = createOcrError(result.message || "AI音声を作れませんでした。しばらくしてから再度お試しください。", result.code);
      // 混み合っているときは、Geminiが教えてくれた待ち時間も受け取ります。
      error.retryAfterMs = Number(result.retryAfterMs) || 0;
      throw error;
    }

    return { pcm: decodeBase64(result.audio), sampleRate: getAudioSampleRate(result.mimeType) };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// 音声の形式（例: audio/L16;codec=pcm;rate=24000）から、1秒あたりの細かさを読み取ります。
function getAudioSampleRate(mimeType) {
  const matched = /rate=(\d+)/.exec(String(mimeType || ""));
  const rate = matched ? Number(matched[1]) : 0;
  return rate >= 8000 && rate <= 48000 ? rate : AI_TTS_DEFAULT_SAMPLE_RATE;
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/**
 * Geminiが返す音声には、そのままでは再生できる形の情報が入っていません。
 * 先頭にWAVの見出し（44バイト）を付けて、ブラウザでも保存先でも再生できるようにします。
 */
function buildWavBlob(pcmParts, sampleRate) {
  const dataLength = pcmParts.reduce((total, part) => total + part.length, 0);
  const channels = 1;
  const bytesPerSample = AI_TTS_BITS_PER_SAMPLE / 8;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  // 1は、圧縮していない音声（PCM）という意味です。
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, AI_TTS_BITS_PER_SAMPLE, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);

  return new Blob([header, ...pcmParts], { type: "audio/wav" });
}

// 作った音声の長さ（秒）です。保存ボタンの表示に使います。
function getAiAudioSeconds() {
  const dataLength = aiAudioParts.reduce((total, part) => total + part.length, 0);
  return Math.round(dataLength / (aiSampleRate * (AI_TTS_BITS_PER_SAMPLE / 8)));
}

function updateDownloadButton() {
  if (aiAudioParts.length === 0) {
    downloadButton.hidden = true;
    return;
  }

  const seconds = getAiAudioSeconds();
  downloadButton.hidden = false;
  downloadButton.innerHTML = `<span aria-hidden="true">⬇</span> <span class="nowrap">音声を保存</span>${seconds > 0 ? ` <span class="nowrap">（約${seconds}秒）</span>` : ""}`;
}

// 新しく読み上げ始めたときや、文章を消したときは、前に作った音声を保存できなくします。
function clearAiAudio() {
  aiAudioParts = [];
  updateDownloadButton();
}

// 保存するファイル名です。日付と声の名前を入れて、あとから見分けられるようにします。
function buildAudioFileName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `yomiage-${aiVoiceUsed || "ai"}-${stamp}.wav`;
}

/**
 * 作った音声を1つのWAVファイルにまとめて保存します。
 * 途中で止めた場合も、そこまでに作った音声を保存できます。
 */
function downloadAiAudio() {
  if (aiAudioParts.length === 0) {
    showError("保存できる音声がありません。AI音声で読み上げてからお試しください。");
    return;
  }

  const url = URL.createObjectURL(buildWavBlob(aiAudioParts, aiSampleRate));
  const link = document.createElement("a");
  link.href = url;
  link.download = buildAudioFileName();
  document.body.append(link);
  link.click();
  link.remove();
  // すぐに片付けると保存が始まらないブラウザがあるため、少し待ってから解放します。
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);

  statusText.classList.remove("error");
  statusText.textContent = `音声を保存しました（${buildAudioFileName()}）。`;
}

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
  // 手で書き換えたときは、画像から読み取った文章ではなくなります。
  markInputSource("text");
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
  const sanitizedText = cleanPastedText(pastedText);
  if (!sanitizedText.trim()) {
    showError("絵文字と空行を除くと、読み上げ可能な文章がありません。");
    return;
  }

  textInput.value = sanitizedText;
  markInputSource("text");
  updateCharacterCount();
  startReading();
});

rateInput.addEventListener("input", () => {
  const rate = Number(rateInput.value) || 1;
  rateOutput.textContent = `${rate.toFixed(1)}倍`;
  rateInput.setAttribute("aria-valuetext", `${rate.toFixed(1)}倍`);

  // 変えた速さは、いま使っている音声の速さとして覚えておきます。
  if (isAiVoiceEnabled()) aiRate = rate;
  else browserRate = rate;

  // AI音声は、再生中でもすぐに速さを変えられます。
  if (isAiPlayback) audioPlayer.playbackRate = getPlaybackRate();
});

speakButton.addEventListener("click", startReading);
clipboardButton.addEventListener("click", readFromClipboard);
copyButton.addEventListener("click", () => copyTextToClipboard(textInput));
pauseButton.addEventListener("click", togglePause);
stopButton.addEventListener("click", () => stopSpeaking());
downloadButton.addEventListener("click", downloadAiAudio);
aiVoiceToggle.addEventListener("change", handleAiVoiceToggle);

// ポップアップの枠外を押すと、閉じて読み上げを停止します。
// click ではなくpointerdownで判定することで、他ボタンのclickより先に処理します。
document.addEventListener("pointerdown", (event) => {
  if (currentSection.hidden || currentSection.contains(event.target)) return;
  // パスワードの入力中は、読み上げの続きを止めないようにします。
  if (passwordDialog.open && passwordDialog.contains(event.target)) return;
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

// 他のタブやアプリから戻ったとき、ブラウザ側が一時停止のまま固まっていることがあります。
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !isReading || isPaused || isAiPlayback) return;
  releasePendingPause();
});

// ページを離れるときにブラウザへ残っている読み上げを確実に解除します。
window.addEventListener("pagehide", () => stopSpeaking(false));
window.addEventListener("beforeunload", () => synthesis.cancel());

// AI音声の一覧と案内は、ブラウザの音声の有無にかかわらず用意します。
loadAiVoices();
updateVoiceNote();

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