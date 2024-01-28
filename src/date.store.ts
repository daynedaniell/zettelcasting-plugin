import { writable } from 'svelte/store';

export const picked_date = writable<Date | null>(null)
