<script lang="ts">
	import Flatpickr from "./Flatpickr.svelte";
	import { createEventDispatcher } from "svelte";

	import { picked_date } from "./date.store";

	const dispatch = createEventDispatcher();

	export let value: undefined = undefined,
		formattedValue: any = "",
		flatpickr: Flatpickr;

	let mode = "single";

	// Default to "now" so the picker shows the same time the post will actually
	// be scheduled for when the user doesn't touch it, and disallow past dates.
	const now = new Date();

	let options;
	$: options = {
		mode,
		defaultDate: now,
		minDate: now,
		enableTime: true,
		minuteIncrement: 1,
		onChange(selectedDates: any) {
			picked_date.set(selectedDates[0] ?? null);
		},
	};

	function handleOpen(event: Event) {
		event.preventDefault();

		// flatpickr moves focus into the calendar itself on open; calling
		// focus() on calendarContainer is a no-op (it has no tabindex).
		flatpickr?.open();
	}

	function handleChange(event: any) {
		const [selectedDates, dateStr] = event.detail;
		dispatch("dateChange", { selectedDates, dateStr });
	}
</script>

<Flatpickr
	{options}
	bind:value
	bind:formattedValue
	on:change={handleChange}
	name="date"
	bind:flatpickr
	dateFormat="Y-m-d"
/>
<button type="button" on:click={handleOpen}> Open picker </button>
