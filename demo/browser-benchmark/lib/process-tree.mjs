import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function windowsTreeRSS(rootPID) {
  const script = `$rows=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId;$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add(${rootPID});$changed=$true;while($changed){$changed=$false;foreach($row in $rows){if($ids.Contains([int]$row.ParentProcessId)-and $ids.Add([int]$row.ProcessId)){$changed=$true}}};$total=0;foreach($id in $ids){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($p){$total+=$p.WorkingSet64}};Write-Output $total`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 4 * 1024 * 1024 });
  return Number(stdout.trim());
}

async function unixTreeRSS(rootPID) {
  const { stdout } = await execFileAsync('ps', ['-e', '-o', 'pid=,ppid=,rss=']);
  const rows = stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
  const ids = new Set([rootPID]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of rows) {
      if (ids.has(ppid) && !ids.has(pid)) {
        ids.add(pid);
        changed = true;
      }
    }
  }
  return rows.reduce((total, [pid, , rssKB]) => total + (ids.has(pid) ? rssKB * 1024 : 0), 0);
}

export async function processTreeRSS(rootPID = process.pid) {
  return process.platform === 'win32' ? windowsTreeRSS(rootPID) : unixTreeRSS(rootPID);
}
