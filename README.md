# Dashboard Hub for Unraid

A modern overview for the **Dashboard** tab of Unraid 7 – with Unraid's own tile view one click away.

## What it shows

- **Needs attention** – one strip for the things that matter: disk errors or disabled disks, hot disks or CPU, nearly full pools, a UPS on battery, Tailscale logged out, containers that should be running but are not, and services that stopped answering. When everything is fine it simply says so.
- **Processor** – total load with a short history, a strip with the load of every thread, temperature and load average.
- **Memory** – used, cache and free, with history.
- **Graphics** – GPU load, video and shared memory, temperatures (AMD and Intel iGPUs via sysfs). NVIDIA cards (with the Nvidia Driver plugin) also show power draw against the limit, fan, power state and which containers use the GPU.
- **GPU energy & cost** – for NVIDIA cards a small collector measures the power every 5 seconds. The card shows the cost of today, this month (with forecast) and per year, the idle draw, a 30-day chart, today's power curve and which container used how much. The electricity price is set right in the card.
- **Power / UPS** – watts (when the UPS reports its capacity), load, battery, runtime and processor package power.
- **Storage** – array capacity, parity check progress with speed and time left (or the result of the last check), every array disk, pool and the boot device with usage, temperature, standby and errors.
- **Network** – live download/upload of the main interface, the busiest VLANs and the Tailscale state.
- **Containers & VMs** – running, needing attention and updates, top CPU and memory users, virtual machines. Uses [Container Hub](https://github.com/LX-S93/unraid-container-hub) when it is installed (logos, health, usage) and falls back to Unraid's own data otherwise.
- **Services** – the web interfaces you want to keep an eye on, checked every minute from the server with response time. Pick them from your containers or add any address with *Edit*.

*Classic view* in the title bar switches to Unraid's original dashboard; *Dashboard Hub* switches back. With tabbed page view enabled in Display Settings both appear as tabs.

## Installation

Unraid 7.0 or newer. **Plugins › Install Plugin**:

```
https://raw.githubusercontent.com/LX-S93/unraid-dashboard/main/dashboard.hub.plg
```

## Data

`/boot/config/plugins/dashboard.hub/settings.json` holds the list of watched services and the electricity price. `gpu-energy.json` is the GPU energy log (kept in RAM and copied to the flash drive once an hour, 400 days). Removing the plugin keeps this folder.

## Building

```
./pkg_build.sh 2026.11.06
```

## License

MIT
