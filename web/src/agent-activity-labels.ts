import type { LanguageCode } from "./i18n"
import type { AgentActivity, GroupBy, RecentWindow } from "./agent-activity"

/**
 * Labels for the activity vocabulary, grouping and time window. A small table of its own, like the
 * federation labels, so the Session rail can name them in every language without growing the main
 * dictionary; the tests require every language to define every key.
 */
export type ActivityLabels = {
  activity: Record<AgentActivity, string>
  groupBy: string
  group: Record<GroupBy, string>
  /** The heading of the single group when nothing is grouped. */
  recentFeed: string
  window: string
  windows: Record<RecentWindow, string>
  background: string
  backgroundTitle: string
  started: string
  lastRan: string
  neverRan: string
  noMatchInWindow: string
  /** The strip above a background agent's Session. */
  bar: {
    followingLive: string
    answerInTerminal: string
    stop: string
    cancel: string
    stopConfirm: string
    logs: string
    hideLogs: string
    refresh: string
    logsEmpty: string
    logsTruncated: string
    continueInBackground: string
    continueHint: string
    continuePlaceholder: string
    send: string
    remove: string
    removeConfirm: string
    failed: string
    subagents: string
  }
}

export const ACTIVITY_LABELS: Record<LanguageCode, ActivityLabels> = {
  en: {
    activity: { working: "Working", needs_input: "Needs you", idle: "Idle", completed: "Completed", failed: "Failed", stopped: "Stopped" },
    groupBy: "Group by",
    group: { "machine-project": "Machine › Project", none: "Recent (no grouping)", status: "Status", project: "Project", machine: "Machine", agent: "Agent" },
    recentFeed: "Recent",
    window: "Last ran",
    windows: { any: "Any time", "1h": "Past hour", "24h": "Past day", "7d": "Past week" },
    background: "Background",
    backgroundTitle: "A Claude Code background agent",
    started: "Started",
    lastRan: "Last ran",
    neverRan: "Not run yet",
    noMatchInWindow: "Nothing has run in that time.",
    bar: {
      followingLive: "Following a background agent. It is running on its own, so you can read along but not send messages until it finishes.",
      answerInTerminal: "It is waiting for an answer. Give it in the agent's own terminal:",
      stop: "Stop",
      cancel: "Cancel",
      stopConfirm: "Stop this background agent? Its conversation is kept.",
      logs: "Output",
      hideLogs: "Hide output",
      refresh: "Refresh",
      logsEmpty: "No output yet.",
      logsTruncated: "Showing the most recent output.",
      continueInBackground: "Continue in background",
      continueHint: "Send another instruction. The agent picks up where it left off and keeps running in the background.",
      continuePlaceholder: "What should it do next?",
      send: "Send",
      remove: "Remove",
      removeConfirm: "Remove this background agent? Claude refuses if its worktree has unpushed work.",
      failed: "That did not work:",
      subagents: "Sub-agents"
    }
  },
  it: {
    activity: { working: "In corso", needs_input: "Serve te", idle: "Inattivo", completed: "Completato", failed: "Non riuscito", stopped: "Fermato" },
    groupBy: "Raggruppa per",
    group: { "machine-project": "Macchina › Progetto", none: "Recenti (senza gruppi)", status: "Stato", project: "Progetto", machine: "Macchina", agent: "Agente" },
    recentFeed: "Recenti",
    window: "Ultima esecuzione",
    windows: { any: "Sempre", "1h": "Ultima ora", "24h": "Ultimo giorno", "7d": "Ultima settimana" },
    background: "Sfondo",
    backgroundTitle: "Un agente Claude Code in background",
    started: "Avviato",
    lastRan: "Ultima esecuzione",
    neverRan: "Mai eseguito",
    noMatchInWindow: "Nulla è stato eseguito in questo periodo.",
    bar: {
      followingLive: "Stai seguendo un agente in background. Lavora da solo: puoi leggere ma non inviare messaggi finché non finisce.",
      answerInTerminal: "Attende una risposta. Dagliela nel terminale dell'agente:",
      stop: "Ferma",
      cancel: "Annulla",
      stopConfirm: "Fermare questo agente in background? La conversazione viene conservata.",
      logs: "Output",
      hideLogs: "Nascondi output",
      refresh: "Aggiorna",
      logsEmpty: "Ancora nessun output.",
      logsTruncated: "Mostro l'output più recente.",
      continueInBackground: "Continua in background",
      continueHint: "Invia un'altra istruzione. L'agente riprende da dove era e continua in background.",
      continuePlaceholder: "Cosa deve fare ora?",
      send: "Invia",
      remove: "Rimuovi",
      removeConfirm: "Rimuovere questo agente in background? Claude rifiuta se il suo worktree ha lavoro non pubblicato.",
      failed: "Operazione non riuscita:",
      subagents: "Sotto-agenti"
    }
  },
  "zh-TW": {
    activity: { working: "執行中", needs_input: "需要你", idle: "閒置", completed: "已完成", failed: "失敗", stopped: "已停止" },
    groupBy: "分組方式",
    group: { "machine-project": "機器 › 專案", none: "最近（不分組）", status: "狀態", project: "專案", machine: "機器", agent: "代理" },
    recentFeed: "最近",
    window: "最後執行",
    windows: { any: "不限時間", "1h": "過去一小時", "24h": "過去一天", "7d": "過去一週" },
    background: "背景",
    backgroundTitle: "Claude Code 背景代理",
    started: "開始",
    lastRan: "最後執行",
    neverRan: "尚未執行",
    noMatchInWindow: "這段時間沒有執行任何項目。",
    bar: {
      followingLive: "正在追蹤背景代理。它自行執行，完成前你只能閱讀，無法傳送訊息。",
      answerInTerminal: "它正在等待回答。請在該代理自己的終端機中回覆：",
      stop: "停止",
      cancel: "取消",
      stopConfirm: "要停止這個背景代理嗎？對話會保留。",
      logs: "輸出",
      hideLogs: "隱藏輸出",
      refresh: "重新整理",
      logsEmpty: "尚無輸出。",
      logsTruncated: "顯示最近的輸出。",
      continueInBackground: "在背景繼續",
      continueHint: "傳送另一項指示。代理會從上次停下的地方繼續，並持續在背景執行。",
      continuePlaceholder: "接下來要做什麼？",
      send: "傳送",
      remove: "移除",
      removeConfirm: "要移除這個背景代理嗎？若其工作樹有尚未推送的內容，Claude 會拒絕。",
      failed: "操作失敗：",
      subagents: "子代理"
    }
  },
  "zh-CN": {
    activity: { working: "运行中", needs_input: "需要你", idle: "空闲", completed: "已完成", failed: "失败", stopped: "已停止" },
    groupBy: "分组方式",
    group: { "machine-project": "机器 › 项目", none: "最近（不分组）", status: "状态", project: "项目", machine: "机器", agent: "代理" },
    recentFeed: "最近",
    window: "最后运行",
    windows: { any: "不限时间", "1h": "过去一小时", "24h": "过去一天", "7d": "过去一周" },
    background: "后台",
    backgroundTitle: "Claude Code 后台代理",
    started: "开始",
    lastRan: "最后运行",
    neverRan: "尚未运行",
    noMatchInWindow: "这段时间没有运行任何内容。",
    bar: {
      followingLive: "正在跟踪后台代理。它自行运行，完成前你只能阅读，无法发送消息。",
      answerInTerminal: "它正在等待回答。请在该代理自己的终端中回复：",
      stop: "停止",
      cancel: "取消",
      stopConfirm: "要停止这个后台代理吗？对话会保留。",
      logs: "输出",
      hideLogs: "隐藏输出",
      refresh: "刷新",
      logsEmpty: "暂无输出。",
      logsTruncated: "显示最近的输出。",
      continueInBackground: "在后台继续",
      continueHint: "发送另一项指示。代理会从上次停下的地方继续，并持续在后台运行。",
      continuePlaceholder: "接下来要做什么？",
      send: "发送",
      remove: "移除",
      removeConfirm: "要移除这个后台代理吗？如果其工作树有未推送的内容，Claude 会拒绝。",
      failed: "操作失败：",
      subagents: "子代理"
    }
  }
}

export function activityLabels(language: LanguageCode): ActivityLabels {
  return ACTIVITY_LABELS[language] ?? ACTIVITY_LABELS.en
}
