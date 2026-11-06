<?php
// Dashboard Hub – JSON API (read via GET, write only via POST; Unraid checks the csrf_token on POST)
require_once __DIR__ . '/lib.php';

// Unraid's Docker library expects $docroot and its own globals at file level
$docroot = $docroot ?? ($_SERVER['DOCUMENT_ROOT'] ?? '') ?: '/usr/local/emhttp';
if (in_array($_REQUEST['action'] ?? '', ['containers', 'services', 'candidates'], true)
  && is_file("$docroot/plugins/dynamix.docker.manager/include/DockerClient.php")) {
  require_once "$docroot/plugins/dynamix.docker.manager/include/DockerClient.php";
}

function dh_req($k, $def = '') { return trim((string)($_REQUEST[$k] ?? $def)); }
function dh_out($d) {
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: no-store');
  echo json_encode(['ok' => true] + $d, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
  exit;
}

try {
  switch (dh_req('action')) {
    case 'live':
      dh_out(dh_live());
    case 'storage':
      dh_out(dh_storage());
    case 'system':
      dh_out(dh_system());
    case 'containers':
      dh_out(dh_containers() ?? ['containers' => null]);
    case 'services':
      $s = dh_settings();
      $list = $s['services'];
      $auto = false;
      if (!is_array($list)) {
        $c = dh_containers();
        $list = dh_default_services($c['containers'] ?? []);
        $auto = true;
      }
      dh_out(['services' => $list, 'auto' => $auto, 'checks' => dh_check_services($list)]);
    case 'candidates':
      $c = dh_containers();
      $out = [];
      foreach ($c['containers'] ?? [] as $x) if (!empty($x['url'])) $out[] = ['name' => $x['name'], 'url' => $x['url'], 'running' => $x['running']];
      usort($out, function ($a, $b) { return strcasecmp($a['name'], $b['name']); });
      dh_out(['candidates' => $out]);
    case 'save_services':
      if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') throw new Exception('POST required');
      $in = json_decode((string)($_POST['services'] ?? ''), true);
      if (!is_array($in)) throw new Exception('Invalid list');
      $clean = [];
      foreach (array_slice($in, 0, 40) as $s) {
        $url = trim((string)($s['url'] ?? ''));
        $name = trim(mb_substr((string)($s['name'] ?? ''), 0, 60));
        if ($name === '' || !preg_match('~^https?://[^\s]+$~i', $url)) continue;
        $clean[] = ['name' => $name, 'url' => $url, 'container' => trim((string)($s['container'] ?? ''))];
      }
      $set = dh_settings();
      $set['services'] = $clean;
      dh_json_write(DH_CFG . '/settings.json', $set);
      dh_out(['services' => $clean]);
    case 'energy':
      dh_out(dh_energy());
    case 'save_price':
      if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') throw new Exception('POST required');
      $price = (float)str_replace(',', '.', (string)($_POST['price'] ?? ''));
      if ($price <= 0 || $price > 5) throw new Exception('Please enter a price between 0 and 5 per kWh');
      $set = dh_settings();
      $set['energy_price'] = round($price, 4);
      dh_json_write(DH_CFG . '/settings.json', $set);
      dh_out(['price' => $set['energy_price']]);
    default:
      throw new Exception('Unknown action');
  }
} catch (Throwable $e) {
  http_response_code(400);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(['ok' => false, 'error' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
