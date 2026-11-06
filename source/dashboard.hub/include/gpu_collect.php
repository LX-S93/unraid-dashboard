<?php
// Dashboard Hub – runs once a minute from cron and logs the energy used by NVIDIA cards
require_once __DIR__ . '/lib.php';
dh_energy_collect();
