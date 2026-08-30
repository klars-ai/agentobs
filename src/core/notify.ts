/**
 * Desktop notifications for budget alerts.
 *
 * A warning printed into a hook's stderr is invisible - the user is looking at
 * their editor, not the agent's plumbing. A desktop notification is the only
 * channel that reaches someone who has stopped watching, which is exactly the
 * person about to be surprised by a bill or a lockout.
 *
 * Uses each OS's built-in mechanism rather than a dependency: node-notifier
 * would add a package tree to a tool whose install speed is part of the pitch.
 * Fails silently by design - a notification that cannot be shown must never
 * become an error in the agent's path.
 */
import { spawn } from 'node:child_process';

export interface Notification {
  title: string;
  body: string;
  /** Urgent notifications are allowed to interrupt; normal ones are not. */
  urgent?: boolean;
}

/**
 * Shows a desktop notification. Never throws, never blocks.
 *
 * Detached and unref'd so the notifier's lifetime is not tied to the hook
 * process, which exits within milliseconds.
 */
export function notify(n: Notification): void {
  try {
    const [cmd, args] = commandFor(n);
    if (!cmd) return;
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {
      /* no notifier available - silence is correct here */
    });
    child.unref();
  } catch {
    /* never let a notification break the caller */
  }
}

function commandFor(n: Notification): [string | null, string[]] {
  const title = sanitize(n.title);
  const body = sanitize(n.body);

  if (process.platform === 'darwin') {
    return [
      'osascript',
      ['-e', `display notification "${body}" with title "${title}"${n.urgent ? ' sound name "Basso"' : ''}`],
    ];
  }

  if (process.platform === 'win32') {
    // Windows toast via PowerShell's BurntToast-free WinRT path is fragile
    // across versions; the message-box fallback is ugly, so use the
    // notification API through a short PowerShell snippet instead.
    const ps = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;',
      '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);',
      `$t.GetElementsByTagName('text')[0].AppendChild($t.CreateTextNode('${title}')) | Out-Null;`,
      `$t.GetElementsByTagName('text')[1].AppendChild($t.CreateTextNode('${body}')) | Out-Null;`,
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('AgentObs').Show([Windows.UI.Notifications.ToastNotification]::new($t));",
    ].join(' ');
    return ['powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]];
  }

  // Linux / BSD
  return ['notify-send', [n.urgent ? '--urgency=critical' : '--urgency=normal', title, body]];
}

/** Strips quotes and newlines that would break the shell/AppleScript string. */
function sanitize(s: string): string {
  return s.replace(/["'`\]/g, '').replace(/[\r\n]+/g, ' ').slice(0, 200);
}
