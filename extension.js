require('dotenv').config()

const vscode = require('vscode')
const cp = require('child_process')
const util = require('util')
const fs = require('fs')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')

const exec = util.promisify(cp.exec)

async function promptAndStoreSupabaseCredentials(context) {
  const url = await vscode.window.showInputBox({
    prompt: 'Enter your Supabase URL',
    ignoreFocusOut: true,
  })
  if (!url) {
    vscode.window.showWarningMessage('Supabase URL is required.')
    return
  }

  const anonKey = await vscode.window.showInputBox({
    prompt: 'Enter your Supabase anon key',
    password: true,
    ignoreFocusOut: true,
  })
  if (!anonKey) {
    vscode.window.showWarningMessage('Supabase anon key is required.')
    return
  }

  await context.secrets.store('supabaseUrl', url)
  await context.secrets.store('supabaseAnonKey', anonKey)

  vscode.window.showInformationMessage(
    'TBK Track: Supabase credentials saved securely!'
  )
}

async function getSupabaseClient(context) {
  const url = await context.secrets.get('supabaseUrl')
  const anonKey = await context.secrets.get('supabaseAnonKey')

  if (!url || !anonKey) {
    vscode.window.showErrorMessage(
      'Supabase credentials not set. Please run "Set Supabase Credentials" command.'
    )
    return null
  }

  return createClient(url, anonKey)
}

/**
 * Get current Git branch name using CLI
 * @param {string} workspacePath
 * @returns {Promise<string|undefined>}
 */
async function getGitBranch(workspacePath) {
  try {
    const { stdout } = await exec('git rev-parse --abbrev-ref HEAD', {
      cwd: workspacePath,
    })
    return stdout.trim()
  } catch (error) {
    console.error('Failed to get Git branch:', error)
    return undefined
  }
}

/** Returns YYYY-MM-DD string */
function getDateKey() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Get log file path inside global storage folder
 * @param {vscode.ExtensionContext} context
 */
function getLogFilePath(context) {
  const storagePath = context.globalStorageUri.fsPath
  if (!fs.existsSync(storagePath)) {
    fs.mkdirSync(storagePath, { recursive: true })
  }
  return path.join(storagePath, 'timetracker.log.json')
}

/**
 * Read logs JSON from storage
 * @param {vscode.ExtensionContext} context
 * @returns {object}
 */
function readLogs(context) {
  const logFilePath = getLogFilePath(context)
  if (!fs.existsSync(logFilePath)) return {}
  try {
    const raw = fs.readFileSync(logFilePath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    vscode.window.showErrorMessage('Failed to parse time tracker log file.')
    return {}
  }
}

/**
 * Write logs JSON to storage
 * @param {vscode.ExtensionContext} context
 * @param {object} logs
 */
function writeLogs(context, logs) {
  const logFilePath = getLogFilePath(context)
  fs.writeFileSync(logFilePath, JSON.stringify(logs, null, 2), 'utf-8')
}

/**
 * Logs the start time and branch into log JSON stored in globalStorage
 * Uses date-keyed structure with arrays of sessions per day
 * @param {vscode.ExtensionContext} context
 * @param {string} branch
 */
function logStartTime(context, branch) {
  const now = new Date().toISOString()

  const logs = readLogs(context)
  const dateKey = getDateKey()
  if (!logs[dateKey]) {
    logs[dateKey] = []
  }

  logs[dateKey].push({
    branch,
    start: now,
    stop: null,
  })

  writeLogs(context, logs)
  vscode.window.showInformationMessage(
    `TBK Track: Started tracking on branch: ${branch}`
  )
}

/**
 * Logs the stop time to the latest open session for today
 * @param {vscode.ExtensionContext} context
 */
function logStopTime(context) {
  const now = new Date().toISOString()
  const logs = readLogs(context)
  const dateKey = getDateKey()

  const daySessions = logs[dateKey]
  if (!daySessions || daySessions.length === 0) {
    vscode.window.showWarningMessage('No running session found to stop.')
    return
  }

  // Find the last session without stop time today
  for (let i = daySessions.length - 1; i >= 0; i--) {
    if (!daySessions[i].stop) {
      daySessions[i].stop = now
      writeLogs(context, logs)
      vscode.window.showInformationMessage('TBK Track: Stopped tracking.')
      return
    }
  }

  vscode.window.showWarningMessage(
    'TBK Track: No running session found to stop.'
  )
}

/**
 * Sync local logs file (from globalStorage) to Supabase
 * @param {vscode.ExtensionContext} context
 */
async function syncLogsToSupabase(context) {
  const supabase = await getSupabaseClient(context)
  if (!supabase) return // Credentials missing

  const logs = readLogs(context)

  if (!logs || Object.keys(logs).length === 0) {
    vscode.window.showWarningMessage('No local logs found to sync.')
    return
  }

  for (const [date, dayLogs] of Object.entries(logs)) {
    const { error } = await supabase
      .from('timetracker_logs')
      .upsert({ date, logs: dayLogs }, { onConflict: 'date' })

    if (error) {
      vscode.window.showErrorMessage(
        `Failed to sync logs for date ${date}: ${error.message}`
      )
      return
    }
  }

  vscode.window.showInformationMessage('TBK Track: Logs synced successfully!')
}

/**
 * Watches for branch changes by monitoring `.git/HEAD`
 * Automatically stops previous and starts new session
 * @param {vscode.ExtensionContext} context
 * @param {string} workspacePath
 */
function watchBranchChanges(context, workspacePath) {
  const gitHeadPath = path.join(workspacePath, '.git', 'HEAD')

  if (!fs.existsSync(gitHeadPath)) {
    console.warn('.git/HEAD not found, not a Git repo.')
    return
  }

  let currentBranch = null

  // Initialize current branch on activation
  getGitBranch(workspacePath).then((branch) => {
    currentBranch = branch
  })

  // Use VS Code watcher for reliability
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspacePath, '.git/HEAD')
  )

  const handleBranchChange = async () => {
    const newBranch = await getGitBranch(workspacePath)
    if (newBranch && newBranch !== currentBranch) {
      logStopTime(context)
      currentBranch = newBranch
      logStartTime(context, newBranch)
      vscode.window.showInformationMessage(
        `TBK Track: Switched to branch: ${newBranch}`
      )
    }
  }

  watcher.onDidChange(handleBranchChange)
  watcher.onDidCreate(handleBranchChange)
  watcher.onDidDelete(() => {
    currentBranch = null
  })

  console.log('Watching for Git branch changes...')
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  const url = await context.secrets.get('supabaseUrl')
  const anonKey = await context.secrets.get('supabaseAnonKey')
  if (!url || !anonKey) {
    vscode.window.showInformationMessage(
      'TBK Track: Supabase credentials are not set. Run "Set Supabase Credentials" command to configure.'
    )
  }

  const workspaceFolders = vscode.workspace.workspaceFolders
  if (workspaceFolders && workspaceFolders.length > 0) {
    const workspacePath = workspaceFolders[0].uri.fsPath
    watchBranchChanges(context, workspacePath)
  }

  const setCredsCommand = vscode.commands.registerCommand(
    'time-tracker.setSupabaseCredentials',
    async () => {
      await promptAndStoreSupabaseCredentials(context)
    }
  )

  const startCommand = vscode.commands.registerCommand(
    'time-tracker.start',
    async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage('No workspace folder found.')
        return
      }

      const workspacePath = workspaceFolders[0].uri.fsPath
      const branch = await getGitBranch(workspacePath)

      if (branch) {
        logStartTime(context, branch)
      } else {
        vscode.window.showWarningMessage(
          'Git branch not found or not a Git repo.'
        )
      }
    }
  )

  const stopCommand = vscode.commands.registerCommand(
    'time-tracker.stop',
    () => {
      logStopTime(context)
    }
  )

  const syncCommand = vscode.commands.registerCommand(
    'time-tracker.sync',
    async () => {
      await syncLogsToSupabase(context)
    }
  )

  context.subscriptions.push(
    setCredsCommand,
    startCommand,
    stopCommand,
    syncCommand
  )
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
}
