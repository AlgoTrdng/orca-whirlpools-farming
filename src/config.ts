import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config()

const configSchema = z.object({
	ANCHOR_PROVIDER_URL: z.string().min(1),
	ANCHOR_WALLET: z.string().min(1),
})

const res = configSchema.safeParse(process.env)

if (!res.success) {
	throw res.error
}

export const { ANCHOR_PROVIDER_URL: RPC_URL } = res.data
