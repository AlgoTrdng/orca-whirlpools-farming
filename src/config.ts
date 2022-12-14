import { PublicKey } from '@solana/web3.js'
import dotenv from 'dotenv'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

dotenv.config()

import { dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const loadEnv = () => {
	const envConfigSchema = z.object({
		ANCHOR_PROVIDER_URL: z.string().min(1),
		ANCHOR_WALLET: z.string().min(1),
		DB_PATH: z.string().min(1),
	})
	const envConfigRes = envConfigSchema.safeParse(process.env)
	if (!envConfigRes.success) {
		throw envConfigRes.error
	}
	return envConfigRes.data
}

const loadConfig = async () => {
	const configSchema = z.object({
		whirlpoolAddress: z
			.string()
			.min(1)
			.transform((addr) => new PublicKey(addr)),
		upperBoundaryPct: z.number().min(0),
		lowerBoundaryPct: z.number().min(0),
		usdcPositionSize: z.number().gt(0),
	})
	const configFile = await fs.readFile(path.join(__dirname, './../config.json'), {
		encoding: 'utf-8',
	})
	const configRes = configSchema.safeParse(JSON.parse(configFile))
	if (!configRes.success) {
		throw configRes.error
	}
	return configRes.data
}

const loadWallet = async (walletFilePath: string) => {
	const walletFile = await fs.readFile(walletFilePath, { encoding: 'utf-8' })
	const walletPrivateKey = Uint8Array.from(JSON.parse(walletFile))
	return walletPrivateKey
}

const envConfig = loadEnv()
const config = await loadConfig()

export const WALLET_PRIVATE_KEY = await loadWallet(envConfig.ANCHOR_WALLET)
export const { ANCHOR_PROVIDER_URL: RPC_URL, DB_PATH } = envConfig
export const {
	whirlpoolAddress: WHIRLPOOL_ADDRESS,
	upperBoundaryPct: UPPER_BOUNDARY_PCT,
	lowerBoundaryPct: LOWER_BOUNDARY_PCT,
	usdcPositionSize: USDC_POSITION_SIZE,
} = config
