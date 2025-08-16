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
  // GammaVault (gETH) = Beacon Proxy（このアドレスにcallしてOK）
  VAULT: "0xdF58eCBF08B539CC1D5E4D7286B5AFf6ec680A88",
};

/** ---- Minimal ABIs ---- */
// GammaVault 独自IF
const GVAULT_ABI = [
  "function assetToken() view returns (address)",                           // 基軸資産（WETH）
  "function getPeriodInfo() view returns (uint256,uint256,uint256)",       // (period, periodLength, periodExpiration)
  "function previewDeposit(uint256 assets) view returns (uint256 shares)", // 1 WETH → gETH（見積り）
  "function previewWithdraw(uint256 shares) view returns (uint256 assets)",// 1 gETH → WETH（見積り）
  "function calculateNAV() view returns (uint256 nav,uint256,uint256,uint256,bool)", // NAV(資産合計, WETH建て)
  // ERC20互換（ガバルトークン自身）
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
];

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// CLI / env
const argv = yargs(hideBin(process.argv))
  .option("rpc", { type: "string", default: process.env.BASE_RPC_URL, describe: "Base RPC URL" })
  .option("interval", { type: "number", default: 300000, describe: "poll間隔(ms) 例:300000=5分" })
  .option("out", { type: "string", default: "data/geth_mid.csv", describe: "CSV出力先" })
  .help().argv;

if (!argv.rpc) {
  console.error("BASE_RPC_URL が未設定です。--rpc または .env を設定してください。");
  process.exit(1);
}
const provider = new ethers.JsonRpcProvider(argv.rpc);

// 1回分の取得
async function fetchOnce() {
  const vault = new ethers.Contract(ADDR.VAULT, GVAULT_ABI, provider);

  // 基礎情報
  const [assetAddr, vDec, sym, totalSupply] = await Promise.all([
    vault.assetToken(),            // WETH アドレス
    vault.decimals(),              // gETH 小数
    vault.symbol(),                // gETH シンボル
    vault.totalSupply(),
  ]);
  const asset = new ethers.Contract(assetAddr, ERC20_ABI, provider);
  const [aDec, aSym] = await Promise.all([asset.decimals(), asset.symbol()]);

  // ---- NAV（真の対ETH価格）: nav / totalSupply ----
  const navTuple = await vault.calculateNAV();          // [nav, amount0, amount1, gsPnl, isNeg]
  const nav = navTuple[0];                              // WETH建て（assetのdecimals）
  const price_nav =
    parseFloat(ethers.formatUnits(nav, aDec)) /
    parseFloat(ethers.formatUnits(totalSupply, vDec));  // WETH per 1 gETH

const mid = price_nav; // 互換のために別名を用意


  // ---- 見積りレート（mint/redeem）: Vaultのpreview系 ----
  const sharesFor1Weth = await vault.previewDeposit(ethers.parseUnits("1", aDec));
  const assetsFor1Share = await vault.previewWithdraw(ethers.parseUnits("1", vDec));
  const mint_q   = 1 / parseFloat(ethers.formatUnits(sharesFor1Weth, vDec)); // 1 gETH あたりのWETH（mint見積）
  const redeem_q =     parseFloat(ethers.formatUnits(assetsFor1Share, aDec)); // 1 gETH → WETH（redeem見積）

  // 期日
  const [, , periodExpiration] = await vault.getPeriodInfo();

  // CSV出力
  const outPath = argv.out;
  if (!existsSync(__dirname + "/data")) mkdirSync(__dirname + "/data", { recursive: true });
  if (!existsSync(outPath)) {
    writeFileSync(
      outPath,
      "timestamp_iso,weth_per_geth_mint,weth_per_geth_redeem,weth_per_geth_mid,asset_symbol,share_symbol,period_expiration_unix\n",
      "utf8"
    );
  }
  const ts = new Date();
  const row = [
    ts.toISOString(),
    mint_q.toFixed(18),
    redeem_q.toFixed(18),
    price_nav.toFixed(18),  // ← mid は NAV
    aSym,
    sym,
    periodExpiration.toString(),
  ].join(",");
  appendFileSync(outPath, row + "\n", "utf8");

// 既にある previewDeposit の戻り値から
const gethPer1WETH_preview = parseFloat(ethers.formatUnits(sharesFor1Weth, vDec));
// NAVから逆算した gETH/WETH
const gethPer1WETH_fromNav = 1 / mid;
// 乖離(bps)
const gap_bps = (gethPer1WETH_preview / gethPer1WETH_fromNav - 1) * 1e4;

console.log(
  `UI-style: ${gethPer1WETH_preview.toFixed(6)} gETH/WETH | `
+ `NAV-implied: ${gethPer1WETH_fromNav.toFixed(6)} gETH/WETH | `
+ `gap: ${gap_bps.toFixed(1)} bps`
);


  console.log(
    `${ts.toISOString()}  NAV=${price_nav.toFixed(8)} WETH/gETH  (mint ${mint_q.toFixed(6)} / redeem ${redeem_q.toFixed(6)})`
  );
}

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
