import glob, os
import pandas as pd
import matplotlib.pyplot as plt
from matplotlib.ticker import ScalarFormatter

os.makedirs("charts", exist_ok=True)
files = sorted(glob.glob("data/geth_mid_*.csv"))
if not files:
    raise SystemExit("no monthly csvs found")

df = pd.concat([pd.read_csv(f) for f in files], ignore_index=True)
df['timestamp_iso'] = pd.to_datetime(df['timestamp_iso'])
df = df.sort_values('timestamp_iso')

# 1) NAV (WETH per gETH)
fig, ax = plt.subplots(figsize=(8,4))
y = df['weth_per_geth_mid']
ax.plot(df['timestamp_iso'], y)
ax.set_title('gETH NAV (WETH per gETH)')
ax.set_xlabel('time'); ax.set_ylabel('WETH/gETH'); ax.grid(True, alpha=0.3)
fmt = ScalarFormatter(useOffset=False, useMathText=False)
fmt.set_scientific(False)
ax.yaxis.set_major_formatter(fmt)
lo, hi = y.min(), y.max()
pad = max((hi - lo) * 3, 0.0005)
ax.set_ylim(max(0.9, lo - pad), min(1.1, hi + pad))
fig.tight_layout(); fig.savefig('charts/geth_nav.png', dpi=160)

# 2) Premium vs ETH (%) = (1/NAV - 1) * 100
prem = (1.0 / y - 1.0) * 100.0
fig, ax = plt.subplots(figsize=(8,4))
ax.plot(df['timestamp_iso'], prem)
ax.set_title('gETH Premium vs ETH (%)')
ax.set_xlabel('time'); ax.set_ylabel('%')
ax.axhline(0, linestyle='--', linewidth=1)
ax.grid(True, alpha=0.3)
fig.tight_layout(); fig.savefig('charts/geth_premium.png', dpi=160)

# 3) gETH / WETH（直感用）
ratio = 1.0 / y
fig, ax = plt.subplots(figsize=(8,4))
ax.plot(df['timestamp_iso'], ratio)
ax.set_title('gETH / WETH')
ax.set_xlabel('time'); ax.set_ylabel('gETH/WETH'); ax.grid(True, alpha=0.3)
fmt2 = ScalarFormatter(useOffset=False, useMathText=False)
fmt2.set_scientific(False)
ax.yaxis.set_major_formatter(fmt2)
rlo, rhi = ratio.min(), ratio.max()
rpad = max((rhi - rlo) * 3, 0.0005)
ax.set_ylim(max(0.95, rlo - rpad), min(1.05, rhi + rpad))
fig.tight_layout(); fig.savefig('charts/geth_ratio.png', dpi=160)
