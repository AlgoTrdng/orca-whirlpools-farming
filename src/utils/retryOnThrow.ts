import { setTimeout } from 'node:timers/promises'

export const retryOnThrow = async <T>(cb: () => Promise<T>, wait = 500): Promise<T> => {
	try {
		const res = await cb()
		return res
	} catch (error) {
		await setTimeout(wait)
		return retryOnThrow(cb, wait)
	}
}
