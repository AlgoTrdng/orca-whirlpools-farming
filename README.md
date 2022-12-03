# Orca whirlpools farming

## Setup

Set env config
```env
ANCHOR_PROVIDER_URL=RPC Node url
ANCHOR_WALLET=path to wallet.json file
DB_PATH=path to db json file
```

Set liquidity position size in [config.ts](./src/config.ts)
- Deposited liquidity value in USDC will be approximately this amount
```ts
// ...
export const POSITION_SIZE_UI =
```

## Run

With pm2
```sh
npm run pm2:prod
```
