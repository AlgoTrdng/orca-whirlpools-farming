import { PublicKey } from '@solana/web3.js'
import { Adapter, Low } from 'lowdb'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { TextFile } from 'lowdb/node'

import { DB_PATH } from './config.js'

type JSONState = {
	position: {
		address: string
		openPrice: number
	} | null
}

type State = {
	position: {
		address: PublicKey
		openPrice: number
	} | null
}

class CustomAdapter implements Adapter<State> {
	#adapter: TextFile

	constructor(filename: string) {
		this.#adapter = new TextFile(filename)
	}

	async read(): Promise<State> {
		const data = await this.#adapter.read()
		if (data === null) {
			return {
				position: null,
			}
		}
		const parsed = JSON.parse(data) as JSONState
		if (parsed.position) {
			return {
				position: {
					address: new PublicKey(parsed.position.address),
					openPrice: parsed.position.openPrice,
				},
			}
		}
		return parsed as State
	}

	async write(data: State) {
		const state = data as JSONState
		if (state.position) {
			state.position.address = state.position.address.toString()
		}
		return this.#adapter.write(JSON.stringify(state, null, 2))
	}
}

const adapter = new CustomAdapter(DB_PATH)
const state = new Low(adapter)

await state.read()

export { state }
