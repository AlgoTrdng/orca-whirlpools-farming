# Orca whirlpools farming

## Setup

- Choose whirlpool from [orca api](https://api.mainnet.orca.so/v1/whirlpool/list)
- Create config.json

```json
{
	"whirlpoolAddress": "7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm", // SOL/USDC whirlpool address
	"upperBoundaryPct": 5, // If price of Sol is 10, upper boundary would be 10.50 USDC
	"lowerBoundaryPct": 5, // If price of Sol is 10, upper boundary would be 9.50 USDC
	"usdcPositionSize": 10 // Total approximate size of position in USDC
}
```

- Create .env file and set env variables

```env
ANCHOR_PROVIDER_URL=RPC Node url
ANCHOR_WALLET=path to wallet.json file which contains wallet private key as array of 8 bit integers
DB_PATH=path to db json file
```

## Run

With pm2

```sh
npm run pm2:prod
```
