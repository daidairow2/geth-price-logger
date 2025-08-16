import { writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import "dotenv/config";
import { ethers } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** ---- Addresses (Base / gETH) ---- */
const ADDR = {
  VAULT: "0xdF58eCBF08B539CC1D5E4D7286B5AFf6ec680A88",      // GammaVault (gETH / ERC-4626)
  DEPOSIT_VAULT: "0x928B3037F235b30cafBeEb72e9DAd0c7d4A5121d",
  WITHDRAW_VAULT: "0xD1F2552A2ec04b04f3e6b92AbF05De16F2B396c6",
};

// 最小ABI
const IFUNDING_VAULT_ABI = [
  "function asset() view returns (address)",
  "function claimToken() view returns (address)",
  "function getPeriodInfo() view returns (uint256 period,uint256 periodLength,uint256 periodExpiration)",
  "function previewDeposit(uint256 assets) view returns (uint256 shares)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
];

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const ERC4626_ABI = [
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)"
];

// CLI / env
const argv = yargs(hideBin(process.argv))
  .option("rpc", { type: "string", default: process.env.BASE_RPC_URL, describe: "Base RPC URL" })
  .option("interval", { type: "number", default: 300000, describe: "poll間隔(ms)。例: 300000=5分" })
  .option("out", { type: "string", default: "data/geth_mid.csv", describe: "CSV出力先" })
  .help().argv;

if (!argv.rpc) {
  console.error("BASE_RPC_URL が未設定です。--rpc または .env を設定してください。");
  process.exit(1);
}
const provider = new ethers.JsonRpcProvider(argv.rpc);

// ========== ここから新しい fetchOnce 本体 ==========
async function fetchOnce() {
  // ---- GammaVault (本体 / ERC-4626) から NAV を取る ----
  const vault = new ethers.Contract(ADDR.VAULT, ERC4626_ABI, provider);

  // 基軸資産(WETH)のアドレス/桁/Symbol と gETH(=Vault自身)の桁/Symbol
  const assetAddr = await vault.asset();
  const assetErc20 = new ethers.Contract(assetAddr, ERC20_ABI, provider);
  const [vaultDec, assetDec, assetSym, shareSym] = await Promise.all([
    vault.decimals(),
    assetErc20.decimals(),
    assetErc20.symbol(),
    new ethers.Contract(ADDR.VAULT, ERC20_ABI, provider).symbol()
  ]);

  // 1 gETH → ? WETH（= NAV：真の対ETH価格）
  const navAssets = await vault.convertToAssets(ethers.parseUnits("1", vaultDec));
  const wethPer1gETH_nav = parseFloat(ethers.formatUnits(navAssets, assetDec));

  // 1 WETH → ? gETH（NAVの逆方向：参考）
  const navShares = await vault.convertToShares(ethers.parseUnits("1", assetDec));
  const gETHper1WETH_nav = parseFloat(ethers.formatUnits(navShares, vaultDec));

  // ---- 参考：待機キュー側（Deposit/Withdraw Vault）ほぼ1:1 ----
  const dep = new ethers.Contract(ADDR.DEPOSIT_VAULT, IFUNDING_VAULT_ABI, provider);
  const wdr = new ethers.Contract(ADDR.WITHDRAW_VAULT, IFUNDING_VAULT_ABI, provider);
  const sharesFor1Asset_q = await dep.previewDeposit(ethers.parseUnits("1", assetDec)); // 1 WETH → ? gETH
  const assetsFor1Share_q = await wdr.previewRedeem(ethers.parseUnits("1", vaultDec));  // 1 gETH → ? WETH
  const mint_q   = 1 / parseFloat(ethers.formatUnits(sharesFor1Asset_q, vaultDec));
  const redeem_q =     parseFloat(ethers.formatUnits(assetsFor1Share_q, assetDec));

  // ---- 出力：mid には NAV を採用（= 対ETHの本命レート）----
  const mid = wethPer1gETH_nav;

  // 窓の期日（おまけ）
  const [, , periodExpiration] = await dep.getPeriodInfo();

  // CSV 1行を組み立て（既存の列名に合わせて mid を上書き保存）
  const ts = new Date();
  const row = [
    ts.toISOString(),
    mint_q.toFixed(18),
    redeem_q.toFixed(18),
    mid.toFixed(18),
    assetSym,
    shareSym,
    periodExpiration.toString()
  ].join(",");

  // CSV 書き込み
  const outPath = argv.out;
  if (!existsSync(__dirname + "/data")) mkdirSync(__dirname + "/data", { recursive: true });
  if (!existsSync(outPath)) {
    writeFileSync(
      outPath,
      "timestamp_iso,weth_per_geth_mint,weth_per_geth_redeem,weth_per_geth_mid,asset_symbol,share_symbol,period_expiration_unix\n",
      "utf8"
    );
  }
  appendFileSync(outPath, row + "\n", "utf8");

  // ログ表示
  console.log(
    `${ts.toISOString()}  NAV=${mid.toFixed(8)} WETH/gETH  ` +
    `[vault g->w ${wethPer1gETH_nav.toFixed(8)} | w->g ${gETHper1WETH_nav.toFixed(8)}] ` +
    `(queue mint ${mint_q.toFixed(6)} / redeem ${redeem_q.toFixed(6)})`
  );
}
// ========== 新しい fetchOnce ここまで ==========

async function main() {
  await fetchOnce();
  if (argv.interval > 0) {
    console.log(`Polling every ${Math.round(argv.interval / 1000)}s → ${argv.out}`);
    setInterval(fetchOnce, argv.interval);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
