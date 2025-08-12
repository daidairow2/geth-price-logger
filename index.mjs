import { writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import "dotenv/config";
import { ethers } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** ---- Addresses (Base / gETH) ----
 * GammaVault (gETH):        0xdF58eCBF08B539CC1D5E4D7286B5AFf6ec680A88
 * DepositVault (gETH):      0x928B3037F235b30cafBeEb72e9DAd0c7d4A5121d
 * WithdrawVault (gETH):     0xD1F2552A2ec04b04f3e6b92AbF05De16F2B396c6
 */
const ADDR = {
  DEPOSIT_VAULT: "0x928B3037F235b30cafBeEb72e9DAd0c7d4A5121d",
  WITHDRAW_VAULT: "0xD1F2552A2ec04b04f3e6b92AbF05De16F2B396c6",
};

// 最小ABI（FundingVault = Deposit/Withdraw共通）
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

async function fetchOnce() {
  const dep = new ethers.Contract(ADDR.DEPOSIT_VAULT, IFUNDING_VAULT_ABI, provider);
  const wdr = new ethers.Contract(ADDR.WITHDRAW_VAULT, IFUNDING_VAULT_ABI, provider);

  // 基軸（WETH）とgETHのdecimalsを取得
  const assetAddr = await dep.asset();
  const claimAddr = await dep.claimToken(); // = gETH
  const asset = new ethers.Contract(assetAddr, ERC20_ABI, provider);
  const claim = new ethers.Contract(claimAddr, ERC20_ABI, provider);
  const [assetDec, claimDec, assetSym, claimSym] = await Promise.all([
    asset.decimals(), claim.decimals(), asset.symbol(), claim.symbol()
  ]);

  // 1 WETH → ? gETH（Depositサイドの見積もり）
  const unitAsset = ethers.parseUnits("1", assetDec);
  const sharesFor1Asset = await dep.previewDeposit(unitAsset); // shares = gETH見込み
  const sharesPer1WETH = parseFloat(ethers.formatUnits(sharesFor1Asset, claimDec));

  // 1 gETH → ? WETH（Withdrawサイドの見積もり）
  const unitShare = ethers.parseUnits("1", claimDec);
  const assetsFor1Share = await wdr.previewRedeem(unitShare);
  const wethPer1gETH_redeem = parseFloat(ethers.formatUnits(assetsFor1Share, assetDec));

  // 価格（WETH/gETH）
  const wethPer1gETH_mint = 1 / sharesPer1WETH;
  const mid = (wethPer1gETH_mint + wethPer1gETH_redeem) / 2;

  // 窓の情報（オプション）
  const [, , periodExpiration] = await dep.getPeriodInfo();
  const ts = new Date();
  const row = [
    ts.toISOString(),
    wethPer1gETH_mint.toFixed(18),
    wethPer1gETH_redeem.toFixed(18),
    mid.toFixed(18),
    assetSym,
    claimSym,
    periodExpiration.toString()
  ].join(",");

  // CSV書き込み
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

  // 控えめに標準出力
  console.log(
    `${ts.toISOString()}  mid=${mid.toFixed(6)} WETH/gETH  [mint=${wethPer1gETH_mint.toFixed(6)}, redeem=${wethPer1gETH_redeem.toFixed(6)}]`
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
