<?php
// Dashboard Hub – NVIDIA cards: live values, and an energy log written by a once-a-minute collector

const DH_NV_RAM = '/var/local/dashboard.hub';           // RAM: written every minute
const DH_NV_LOG = 'gpu-energy.json';                    // copied to the flash drive once an hour
const DH_NV_KEEP_DAYS = 400;

function dh_has_nvidia() {
  static $has = null;
  if ($has === null) $has = is_executable('/usr/bin/nvidia-smi') && is_file('/proc/driver/nvidia/version');
  return $has;
}

// Unraid's PHP runs in UTC; days and months should follow the server's time zone
function dh_local_tz() {
  static $done = false;
  if ($done) return;
  $done = true;
  $var = dh_ini(DH_EMHTTP . '/var.ini');
  $tz = $var['timeZone'] ?? '';
  if ($tz && @date_default_timezone_set($tz)) return;
  $link = @readlink('/etc/localtime');
  if ($link && preg_match('~zoneinfo/(.+)$~', $link, $m)) @date_default_timezone_set($m[1]);
}

// docker container id -> name, cached for a minute
function dh_ct_names() {
  $cache = '/tmp/dashboard.hub-ctnames.json';
  if (is_file($cache) && filemtime($cache) > time() - 60) {
    $d = json_decode(@file_get_contents($cache), true);
    if (is_array($d)) return $d;
  }
  $map = [];
  foreach (dh_sh("docker ps --no-trunc --format '{{.ID}} {{.Names}}'") as $l) {
    $p = explode(' ', trim($l), 2);
    if (count($p) === 2) $map[$p[0]] = $p[1];
  }
  @file_put_contents($cache, json_encode($map));
  return $map;
}

// which container (or host process) a PID belongs to
function dh_pid_owner($pid, $names) {
  $cg = @file_get_contents("/proc/$pid/cgroup");
  if ($cg && preg_match('/([0-9a-f]{64})/', $cg, $m)) return $names[$m[1]] ?? substr($m[1], 0, 12);
  $comm = trim((string)@file_get_contents("/proc/$pid/comm"));
  return $comm !== '' ? $comm . ' (host)' : 'host';
}

function dh_num($v) {
  $v = trim((string)$v);
  return ($v === '' || stripos($v, 'N/A') !== false || stripos($v, 'not') !== false || $v === '[N/A]') ? null : (float)$v;
}

// live values of every NVIDIA card
function dh_nvidia() {
  if (!dh_has_nvidia()) return [];
  $q = 'index,name,uuid,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,pstate,clocks.sm,clocks.max.sm';
  $rows = dh_sh("timeout 5 nvidia-smi --query-gpu=$q --format=csv,noheader,nounits");
  if (!$rows) return [];
  $procs = [];
  $names = null;
  foreach (dh_sh('timeout 5 nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits') as $l) {
    $p = array_map('trim', explode(',', $l));
    if (count($p) < 3 || !ctype_digit($p[1])) continue;
    if ($names === null) $names = dh_ct_names();
    $procs[$p[0]][] = ['pid' => (int)$p[1], 'name' => dh_pid_owner((int)$p[1], $names), 'mem' => (dh_num($p[2]) ?? 0) * 1048576];
  }
  $out = [];
  foreach ($rows as $l) {
    $p = array_map('trim', explode(',', $l));
    if (count($p) < 14) continue;
    $out[] = ['vendor' => 'NVIDIA', 'card' => 'nvidia' . $p[0], 'name' => preg_replace('/^NVIDIA\s+(GeForce\s+)?/i', '', $p[1]),
      'busy' => dh_num($p[3]) ?? 0, 'mem_busy' => dh_num($p[4]),
      'vram_used' => (dh_num($p[5]) ?? 0) * 1048576, 'vram_total' => (dh_num($p[6]) ?? 0) * 1048576,
      'temp' => dh_num($p[7]), 'power' => dh_num($p[8]), 'power_limit' => dh_num($p[9]), 'fan' => dh_num($p[10]),
      'pstate' => $p[11], 'clock' => dh_num($p[12]), 'clock_max' => dh_num($p[13]), 'procs' => $procs[$p[2]] ?? []];
  }
  return $out;
}

/* ---------- energy log ---------- */

function dh_energy_read() {
  $ram = DH_NV_RAM . '/' . DH_NV_LOG;
  $d = dh_json_read($ram, null);
  if (!is_array($d)) $d = dh_json_read(DH_CFG . '/' . DH_NV_LOG, null);   // after a reboot
  if (!is_array($d)) $d = [];
  return $d + ['v' => 1, 'since' => null, 'days' => [], 'today' => ['date' => '', 'w' => []], 'idle_w' => null];
}

// one minute: sample power every 5 seconds, split the energy between idle and the processes using the GPU
function dh_energy_collect() {
  if (!dh_has_nvidia()) return;
  dh_local_tz();
  @mkdir(DH_NV_RAM, 0755, true);
  $lock = fopen(DH_NV_RAM . '/collect.lock', 'c');
  if (!flock($lock, LOCK_EX | LOCK_NB)) return;

  $samples = [];
  $util = [];
  $end = time() + 54;
  $pmon = null;
  for ($i = 0; time() < $end; $i++) {
    foreach (dh_sh('timeout 5 nvidia-smi --query-gpu=power.draw,utilization.gpu --format=csv,noheader,nounits') as $n => $l) {
      $p = array_map('trim', explode(',', $l));
      $w = dh_num($p[0] ?? '');
      if ($w !== null) { $samples[$n][] = $w; $util[$n][] = dh_num($p[1] ?? '') ?? 0; }
    }
    // per-process load once, in the middle of the minute
    if ($i === 5) $pmon = dh_sh('timeout 8 nvidia-smi pmon -c 1 -s u');
    sleep(5);
  }
  if (!$samples) { flock($lock, LOCK_UN); return; }

  // average power of all cards together for this minute
  $w = 0; $busy = 0;
  foreach ($samples as $n => $s) { $w += array_sum($s) / count($s); $busy = max($busy, array_sum($util[$n]) / count($util[$n])); }
  $wh = $w / 60;

  // load per process (pmon: gpu pid type sm mem … command)
  $names = dh_ct_names();
  $share = [];
  foreach ((array)$pmon as $l) {
    if ($l === '' || $l[0] === '#') continue;
    $p = preg_split('/\s+/', trim($l));
    if (count($p) < 4 || !ctype_digit($p[1])) continue;
    $who = dh_pid_owner((int)$p[1], $names);
    $share[$who] = ($share[$who] ?? 0) + (is_numeric($p[3]) ? (float)$p[3] : 0);
  }

  $d = dh_energy_read();
  $day = date('Y-m-d');
  if (!$d['since']) $d['since'] = time();

  // idle draw = lowest minute average of the last 7 days (what the card needs doing nothing)
  $mins = [];
  foreach ($d['days'] as $k => $x) if ($k >= date('Y-m-d', strtotime('-7 days')) && isset($x['min_w'])) $mins[] = $x['min_w'];
  $mins[] = $w;
  $idle = max(1, min($mins));
  $d['idle_w'] = round($idle, 1);

  $e = $d['days'][$day] ?? ['wh' => 0, 'idle_wh' => 0, 'min_w' => null, 'max_w' => 0, 'busy_min' => 0, 'minutes' => 0, 'apps' => []];
  $e['wh'] += $wh;
  $e['minutes']++;
  $e['min_w'] = $e['min_w'] === null ? round($w, 1) : min($e['min_w'], round($w, 1));
  $e['max_w'] = max($e['max_w'], round(max(array_map('max', $samples)), 1));
  if ($busy >= 5) $e['busy_min']++;
  // the part above idle belongs to whoever kept the GPU busy
  $active = max(0, $w - $idle) / 60;
  $idlePart = $wh - $active;
  $tot = array_sum($share);
  if ($active > 0 && $tot > 0) {
    foreach ($share as $who => $s) $e['apps'][$who] = ($e['apps'][$who] ?? 0) + $active * $s / $tot;
  } elseif ($active > 0 && $share) {
    foreach ($share as $who => $s) $e['apps'][$who] = ($e['apps'][$who] ?? 0) + $active / count($share);
  } else {
    $idlePart = $wh;
  }
  $e['idle_wh'] += $idlePart;
  $d['days'][$day] = $e;

  // power curve of today, one value per minute
  if ($d['today']['date'] !== $day) $d['today'] = ['date' => $day, 'w' => []];
  $d['today']['w'][(int)date('G') * 60 + (int)date('i')] = round($w, 1);

  if (count($d['days']) > DH_NV_KEEP_DAYS) { ksort($d['days']); $d['days'] = array_slice($d['days'], -DH_NV_KEEP_DAYS, null, true); }
  dh_json_write(DH_NV_RAM . '/' . DH_NV_LOG, $d);
  // the flash drive only gets a copy once an hour
  $flash = DH_CFG . '/' . DH_NV_LOG;
  if (!is_file($flash) || filemtime($flash) < time() - 3600) dh_json_write($flash, $d);
  flock($lock, LOCK_UN);
}

// summary for the dashboard
function dh_energy() {
  if (!dh_has_nvidia()) return ['nvidia' => false];
  dh_local_tz();
  $d = dh_energy_read();
  $s = dh_settings();
  ksort($d['days']);
  $today = date('Y-m-d');
  $month = date('Y-m');
  $days = [];
  for ($i = 29; $i >= 0; $i--) {
    $k = date('Y-m-d', strtotime("-$i days"));
    $x = $d['days'][$k] ?? null;
    $days[] = ['date' => $k, 'wh' => $x ? round($x['wh'], 1) : null, 'idle_wh' => $x ? round($x['idle_wh'], 1) : null];
  }
  $sum = function ($filter) use ($d) {
    $r = ['wh' => 0, 'idle_wh' => 0, 'minutes' => 0, 'busy_min' => 0, 'apps' => [], 'days' => 0];
    foreach ($d['days'] as $k => $x) {
      if (!$filter($k)) continue;
      $r['wh'] += $x['wh']; $r['idle_wh'] += $x['idle_wh']; $r['minutes'] += $x['minutes']; $r['busy_min'] += $x['busy_min']; $r['days']++;
      foreach ($x['apps'] as $a => $v) $r['apps'][$a] = ($r['apps'][$a] ?? 0) + $v;
    }
    arsort($r['apps']);
    return $r;
  };
  $from30 = date('Y-m-d', strtotime('-29 days'));
  $tw = $d['today']['date'] === $today ? $d['today']['w'] : [];
  $curve = [];
  for ($m = 0; $m < 1440; $m += 5) {
    $v = [];
    for ($j = $m; $j < $m + 5; $j++) if (isset($tw[$j])) $v[] = $tw[$j];
    $curve[] = $v ? round(array_sum($v) / count($v), 1) : null;
  }
  return ['nvidia' => true, 'price' => (float)$s['energy_price'], 'currency' => $s['currency'], 'since' => $d['since'], 'idle_w' => $d['idle_w'],
    'today' => $sum(function ($k) use ($today) { return $k === $today; }),
    'month' => $sum(function ($k) use ($month) { return strpos($k, $month) === 0; }),
    'last30' => $sum(function ($k) use ($from30) { return $k >= $from30; }),
    'days' => $days, 'curve' => $curve, 'now_minute' => (int)date('G') * 60 + (int)date('i'),
    'month_days' => (int)date('t'), 'month_day' => (int)date('j'), 'collecting' => is_file(DH_CFG . '/gpu.cron')];
}
