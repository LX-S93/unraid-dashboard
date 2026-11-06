<?php
// Dashboard Hub – backend helpers (read-only views of the system, plus the plugin's own settings)

const DH_CFG = '/boot/config/plugins/dashboard.hub';
const DH_EMHTTP = '/var/local/emhttp';

function dh_json_read($p, $def) {
  if (!is_file($p)) return $def;
  $d = json_decode(@file_get_contents($p), true);
  return is_array($d) ? $d : $def;
}

function dh_json_write($p, $d) {
  @mkdir(dirname($p), 0777, true);
  file_put_contents("$p.tmp", json_encode($d, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
  rename("$p.tmp", $p);
}

function dh_sh($cmd) {
  $o = [];
  exec($cmd . ' 2>/dev/null', $o);
  return $o;
}

function dh_ini($file, $sections = false) {
  if (!is_file($file)) return [];
  $r = @parse_ini_file($file, $sections, INI_SCANNER_RAW);
  return is_array($r) ? $r : [];
}

function dh_read($f) { return is_readable($f) ? trim((string)@file_get_contents($f)) : ''; }

function dh_settings() {
  $s = dh_json_read(DH_CFG . '/settings.json', []);
  return array_merge(['services' => null, 'hidden' => []], $s);
}

/* ---------- fast changing values (polled every few seconds) ---------- */

function dh_cpu_raw() {
  // [busy, total] jiffies for "cpu" and every "cpuN"; the browser turns two samples into a percentage
  $out = ['all' => [0, 0], 'cores' => []];
  foreach (@file('/proc/stat') ?: [] as $l) {
    if (!preg_match('/^cpu(\d*)\s+(.+)$/', $l, $m)) continue;
    $v = array_map('intval', preg_split('/\s+/', trim($m[2])));
    $v = array_pad($v, 8, 0);
    $total = array_sum(array_slice($v, 0, 8));
    $idle = $v[3] + $v[4];
    if ($m[1] === '') $out['all'] = [$total - $idle, $total];
    else $out['cores'][(int)$m[1]] = [$total - $idle, $total];
  }
  ksort($out['cores']);
  $out['cores'] = array_values($out['cores']);
  return $out;
}

function dh_mem() {
  $m = [];
  foreach (@file('/proc/meminfo') ?: [] as $l) {
    if (preg_match('/^(\w+):\s+(\d+)/', $l, $x)) $m[$x[1]] = (int)$x[2] * 1024;
  }
  $total = $m['MemTotal'] ?? 0;
  $avail = $m['MemAvailable'] ?? 0;
  $cache = ($m['Cached'] ?? 0) + ($m['Buffers'] ?? 0) + ($m['SReclaimable'] ?? 0) - ($m['Shmem'] ?? 0);
  return ['total' => $total, 'used' => max(0, $total - $avail), 'cache' => max(0, $cache), 'free' => $m['MemFree'] ?? 0,
    'swap_total' => $m['SwapTotal'] ?? 0, 'swap_used' => max(0, ($m['SwapTotal'] ?? 0) - ($m['SwapFree'] ?? 0))];
}

function dh_net_raw() {
  $r = [];
  foreach (@file('/proc/net/dev') ?: [] as $l) {
    if (!preg_match('/^\s*([^:\s]+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/', $l, $m)) continue;
    if (!preg_match('/^(eth|bond|br|wlan|enp|eno)\S*$/', $m[1])) continue;
    $r[$m[1]] = [(float)$m[2], (float)$m[3]];
  }
  return $r;
}

function dh_sensors() {
  $j = json_decode(implode("\n", dh_sh('sensors -j')), true);
  $out = ['cpu' => null, 'gpu' => null, 'gpu_power' => null, 'nvme' => [], 'board' => [], 'fans' => []];
  if (!is_array($j)) return $out;
  foreach ($j as $chip => $vals) {
    if (!is_array($vals)) continue;
    foreach ($vals as $label => $v) {
      if (!is_array($v)) continue;
      foreach ($v as $k => $x) {
        if (!is_numeric($x)) continue;
        if (preg_match('/^temp\d+_input$/', $k)) {
          if (preg_match('/^(k10temp|coretemp|zenpower)/', $chip)) {
            if ($out['cpu'] === null || in_array($label, ['Tctl', 'Tdie', 'Package id 0'])) $out['cpu'] = round($x, 1);
          } elseif (strpos($chip, 'amdgpu') === 0 || strpos($chip, 'nouveau') === 0) {
            if ($label === 'edge' || $out['gpu'] === null) $out['gpu'] = round($x, 1);
          } elseif (strpos($chip, 'nvme') === 0) {
            if ($label === 'Composite') $out['nvme'][] = ['chip' => $chip, 'temp' => round($x, 1)];
          } elseif ($x > -40 && $x < 150) {
            $out['board'][] = ['name' => $label, 'chip' => preg_replace('/-.*$/', '', $chip), 'temp' => round($x, 1)];
          }
        } elseif (preg_match('/^power\d+_(average|input)$/', $k) && strpos($chip, 'amdgpu') === 0) {
          $out['gpu_power'] = round($x, 1);
        } elseif (preg_match('/^fan\d+_input$/', $k) && $x > 0) {
          $out['fans'][] = ['name' => $label, 'rpm' => (int)$x];
        }
      }
    }
  }
  return $out;
}

function dh_gpus() {
  $r = [];
  foreach (glob('/sys/class/drm/card[0-9]') ?: [] as $card) {
    $d = "$card/device";
    $busy = dh_read("$d/gpu_busy_percent");
    if ($busy === '') continue;
    $vendor = dh_read("$d/vendor");
    $r[] = ['card' => basename($card), 'busy' => (int)$busy,
      'vram_used' => (float)dh_read("$d/mem_info_vram_used"), 'vram_total' => (float)dh_read("$d/mem_info_vram_total"),
      'gtt_used' => (float)dh_read("$d/mem_info_gtt_used"), 'gtt_total' => (float)dh_read("$d/mem_info_gtt_total"),
      'vendor' => $vendor === '0x1002' ? 'AMD' : ($vendor === '0x8086' ? 'Intel' : ($vendor === '0x10de' ? 'NVIDIA' : $vendor))];
  }
  return $r;
}

function dh_ups() {
  $lines = dh_sh('timeout 3 apcaccess -u');
  if (!$lines) return null;
  $u = [];
  foreach ($lines as $l) {
    $p = explode(':', $l, 2);
    if (count($p) === 2) $u[trim($p[0])] = trim($p[1]);
  }
  if (empty($u['STATUS'])) return null;
  $cfg = dh_ini('/boot/config/plugins/dynamix.apcupsd/dynamix.apcupsd.cfg');
  $nom = (float)($u['NOMPOWER'] ?? 0);
  if (!$nom && !empty($cfg['OVERRIDE_UPS_CAPACITY'])) $nom = (float)$cfg['OVERRIDE_UPS_CAPACITY'];
  $load = isset($u['LOADPCT']) ? (float)$u['LOADPCT'] : null;
  return ['model' => $u['MODEL'] ?? '', 'status' => $u['STATUS'], 'load' => $load, 'nominal' => $nom ?: null,
    'watts' => ($nom && $load !== null) ? round($nom * $load / 100) : null,
    'battery' => isset($u['BCHARGE']) ? (float)$u['BCHARGE'] : null, 'runtime' => isset($u['TIMELEFT']) ? (float)$u['TIMELEFT'] : null,
    'voltage' => isset($u['OUTPUTV']) ? (float)$u['OUTPUTV'] : null, 'line' => isset($u['LINEV']) ? (float)$u['LINEV'] : null];
}

function dh_live() {
  $up = (float)explode(' ', dh_read('/proc/uptime'))[0];
  $load = array_slice(explode(' ', dh_read('/proc/loadavg')), 0, 3);
  return ['time' => microtime(true), 'uptime' => $up, 'load' => array_map('floatval', $load),
    'cpu' => dh_cpu_raw(), 'mem' => dh_mem(), 'net' => dh_net_raw(), 'sensors' => dh_sensors(),
    'gpus' => dh_gpus(), 'ups' => dh_ups()];
}

/* ---------- storage ---------- */

function dh_storage() {
  $var = dh_ini(DH_EMHTTP . '/var.ini');
  $disks = dh_ini(DH_EMHTTP . '/disks.ini', true);
  $disp = dh_ini('/boot/config/plugins/dynamix/dynamix.cfg', true)['display'] ?? [];
  $warnDef = (int)($disp['warning'] ?? 70);
  $critDef = (int)($disp['critical'] ?? 90);
  $hot = (int)($disp['hot'] ?? 45);
  $max = (int)($disp['max'] ?? 55);
  $hotS = (int)($disp['hotssd'] ?? 60);
  $maxS = (int)($disp['maxssd'] ?? 70);
  $list = [];
  foreach ($disks as $k => $d) {
    $type = $d['type'] ?? '';
    $size = (float)($d['size'] ?? 0);
    $status = $d['status'] ?? '';
    // empty array slots are not interesting
    if ($size <= 0 && strpos($status, 'DISK_NP') === 0) continue;
    $rot = ($d['rotational'] ?? '1') === '1';
    $list[] = [
      'name' => $d['name'] ?? $k, 'type' => $type, 'status' => $status, 'color' => $d['color'] ?? '',
      'temp' => is_numeric($d['temp'] ?? '') ? (int)$d['temp'] : null, 'spundown' => ($d['spundown'] ?? '0') === '1',
      'size' => $size * 1024, 'fs_size' => (float)($d['fsSize'] ?? 0) * 1024, 'fs_used' => (float)($d['fsUsed'] ?? 0) * 1024,
      'fs_free' => (float)($d['fsFree'] ?? 0) * 1024, 'fs_type' => $d['fsType'] ?? '', 'errors' => (int)($d['numErrors'] ?? 0),
      'rotational' => $rot, 'transport' => $d['transport'] ?? '', 'device' => $d['device'] ?? '', 'id' => $d['id'] ?? '',
      'warn' => (int)(($d['warning'] ?? '') !== '' ? $d['warning'] : $warnDef), 'crit' => (int)(($d['critical'] ?? '') !== '' ? $d['critical'] : $critDef),
      'hot' => $rot ? $hot : $hotS, 'max' => $rot ? $max : $maxS,
    ];
  }
  // pools: "m-cache2" belongs to the pool "m-cache"
  $names = array_column($list, 'name');
  foreach ($list as &$d) {
    $d['pool'] = '';
    if ($d['type'] !== 'Cache') continue;
    $base = preg_replace('/\d+$/', '', $d['name']);
    $d['pool'] = ($base !== $d['name'] && in_array($base, $names)) ? $base : $d['name'];
  }
  unset($d);
  $last = null;
  $log = @file('/boot/config/parity-checks.log', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
  if ($log) {
    $p = explode('|', end($log));
    // date|duration|speed|status|errors|action|size
    $last = ['date' => $p[0] ?? '', 'duration' => (int)($p[1] ?? 0), 'speed' => $p[2] ?? '', 'status' => $p[3] ?? '',
      'errors' => (int)($p[4] ?? 0), 'action' => $p[5] ?? ''];
  }
  $resync = (float)($var['mdResync'] ?? 0);
  return [
    'state' => $var['mdState'] ?? '', 'fs_state' => $var['fsState'] ?? '',
    'check' => $resync > 0 ? ['action' => $var['mdResyncAction'] ?? '', 'pos' => (float)($var['mdResyncPos'] ?? 0) * 1024,
      'size' => (float)($var['mdResyncSize'] ?? 0) * 1024, 'db' => (float)($var['mdResyncDb'] ?? 0) * 1024,
      'dt' => (float)($var['mdResyncDt'] ?? 0), 'paused' => ($var['mdResyncDt'] ?? '') === '0'] : null,
    'synced' => (int)($var['sbSynced'] ?? 0), 'sync_errors' => (int)($var['sbSyncErrs'] ?? 0), 'last_check' => $last,
    'disks' => $list,
  ];
}

/* ---------- slower system info ---------- */

function dh_notifications() {
  $out = [];
  foreach (glob('/tmp/notifications/unread/*.notify') ?: [] as $f) {
    $n = dh_ini($f);
    $out[] = ['file' => basename($f), 'time' => (int)($n['timestamp'] ?? filemtime($f)), 'event' => $n['event'] ?? '',
      'subject' => $n['subject'] ?? '', 'description' => $n['description'] ?? '', 'importance' => $n['importance'] ?? 'normal'];
  }
  usort($out, function ($a, $b) { return $b['time'] <=> $a['time']; });
  return ['count' => count($out), 'items' => array_slice($out, 0, 8)];
}

function dh_tailscale() {
  if (!is_executable('/usr/local/sbin/tailscale') && !dh_sh('command -v tailscale')) return null;
  $j = json_decode(implode("\n", dh_sh('timeout 3 tailscale status --json')), true);
  if (!is_array($j)) return ['state' => 'Unavailable'];
  $peers = $j['Peer'] ?? [];
  $online = 0;
  foreach ($peers as $p) if (!empty($p['Online'])) $online++;
  return ['state' => $j['BackendState'] ?? '', 'name' => $j['Self']['HostName'] ?? '', 'dns' => rtrim($j['Self']['DNSName'] ?? '', '.'),
    'ips' => $j['TailscaleIPs'] ?? [], 'peers' => count($peers), 'online' => $online, 'version' => $j['Version'] ?? ''];
}

function dh_vms() {
  if (!is_file('/var/run/libvirt/libvirtd.pid')) return null;
  $r = [];
  foreach (dh_sh('timeout 3 virsh list --all') as $l) {
    if (!preg_match('/^\s*(\d+|-)\s+(.+?)\s{2,}(\S.*)$/', $l, $m)) continue;
    $r[] = ['name' => trim($m[2]), 'state' => trim($m[3])];
  }
  return $r;
}

function dh_system() {
  $var = dh_ini(DH_EMHTTP . '/var.ini');
  $cpu = '';
  foreach (@file('/proc/cpuinfo') ?: [] as $l) if (preg_match('/^model name\s*:\s*(.+)$/', $l, $m)) { $cpu = $m[1]; break; }
  $board = trim(dh_read('/sys/class/dmi/id/product_name') ?: dh_read('/sys/class/dmi/id/board_name'));
  $net = dh_ini(DH_EMHTTP . '/network.ini', true);
  return ['name' => $var['NAME'] ?? gethostname(), 'version' => $var['version'] ?? '', 'comment' => $var['COMMENT'] ?? '',
    'cpu' => $cpu, 'threads' => count(dh_cpu_raw()['cores']), 'board' => $board,
    'ip' => $net['eth0']['IPADDR:0'] ?? '', 'notifications' => dh_notifications(), 'tailscale' => dh_tailscale(), 'vms' => dh_vms(),
    'container_hub' => is_dir('/usr/local/emhttp/plugins/container.hub')];
}

/* ---------- containers (fallback when Container Hub is not installed) ---------- */

// Unraid's Docker library must be loaded at file level (it relies on globals), see dh_need_docker() in api.php
function dh_containers() {
  if (!is_file('/var/run/dockerd.pid') || !class_exists('DockerClient')) return null;
  $info = (new DockerTemplates())->getAllInfo();
  $auto = [];
  foreach ((array)@file('/var/lib/docker/unraid-autostart', FILE_IGNORE_NEW_LINES) as $l) {
    $p = preg_split('/\s+/', trim((string)$l));
    if ($p[0] !== '') $auto[$p[0]] = true;
  }
  $list = [];
  foreach ((new DockerClient())->getDockerContainers() as $c) {
    $n = $c['Name'];
    $i = $info[$n] ?? [];
    $icon = $i['icon'] ?? '';
    $list[] = ['name' => $n, 'running' => (bool)$c['Running'], 'paused' => (bool)$c['Paused'], 'state' => $c['Running'] ? 'running' : 'exited',
      'health' => '', 'autostart' => isset($auto[$n]), 'update' => ($i['updated'] ?? '') === 'false', 'url' => $i['url'] ?? '',
      'icon' => strpos($icon, 'question.png') === false ? $icon : ''];
  }
  return ['containers' => $list];
}

/* ---------- homelab services ---------- */

// containers whose name suggests a service people like to keep an eye on
const DH_KNOWN = ['home-assistant', 'homeassistant', 'frigate', 'pihole', 'pi-hole', 'adguard', 'paperless', 'vaultwarden', 'unifi',
  'nextcloud', 'immich', 'emby', 'jellyfin', 'plex', 'grafana', 'uptime', 'nginx-proxy', 'npm', 'portainer', 'mealie', 'zigbee2mqtt', 'node-red'];

function dh_default_services($containers) {
  $out = [];
  foreach ($containers as $c) {
    if (empty($c['url']) || empty($c['running'])) continue;
    $n = strtolower($c['name']);
    foreach (DH_KNOWN as $k) {
      if (strpos($n, $k) !== false) { $out[] = ['name' => $c['name'], 'url' => $c['url'], 'container' => $c['name']]; break; }
    }
    if (count($out) >= 8) break;
  }
  return $out;
}

function dh_check_services($services) {
  if (!$services) return [];
  $mh = curl_multi_init();
  $hs = [];
  foreach ($services as $i => $s) {
    $u = (string)($s['url'] ?? '');
    if (!preg_match('~^https?://~i', $u)) continue;
    $h = curl_init($u);
    curl_setopt_array($h, [CURLOPT_NOBODY => false, CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3,
      CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_TIMEOUT => 5, CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0,
      CURLOPT_RANGE => '0-2047', CURLOPT_USERAGENT => 'DashboardHub/1.0 (Unraid)']);
    curl_multi_add_handle($mh, $h);
    $hs[$i] = $h;
  }
  do {
    $st = curl_multi_exec($mh, $run);
    if ($run) curl_multi_select($mh, 0.5);
  } while ($run && $st === CURLM_OK);
  $out = [];
  foreach ($hs as $i => $h) {
    $code = (int)curl_getinfo($h, CURLINFO_RESPONSE_CODE);
    $out[$i] = ['code' => $code, 'ms' => (int)round(curl_getinfo($h, CURLINFO_TOTAL_TIME) * 1000),
      'up' => $code > 0 && $code < 500, 'error' => $code ? '' : curl_error($h)];
    curl_multi_remove_handle($mh, $h);
    curl_close($h);
  }
  curl_multi_close($mh);
  return $out;
}
