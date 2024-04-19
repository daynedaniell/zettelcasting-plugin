<script lang="ts">
	import Flatpickr from "./Flatpickr.svelte";
	import { createEventDispatcher } from "svelte";

	import type EasyBake from "./main";

	import { picked_date } from "./date.store";

	let plugin: EasyBake;

	const dispatch = createEventDispatcher();

	export let value: undefined = undefined,
		formattedValue: any,
		flatpickr;

	let mode = "single";

	let options;
	$: options = {
		mode,
		defaultDate:
			mode === "single" ? "2024-01-01" : ["2024-04-01", "2024-04-04"],
		enableTime: true,
		minuteIncrement: 1,
		onChange(selectedDates: any, dateStr: string) {
			picked_date.set(selectedDates[0]);
			console.log("flatpickr hook", selectedDates, dateStr);
		},
		onOpen() {
			console.log("opened");
		},
	};

	function handleOpen(event) {
		event.preventDefault();

		if (flatpickr) {
			flatpickr.open();
			flatpickr.calendarContainer.focus();
		}
	}

	function handleChange(event: any) {
		const [selectedDates, dateStr] = event.detail;
		console.log({ selectedDates, dateStr });
		dispatch("dateChange", { selectedDates, dateStr });
	}

	function handleClear() {
		if (flatpickr) {
			flatpickr.clear();
		}
	}

	function handleSubmit(event) {
		event.preventDefault();

		console.log(
			"coming from the component itself on handleSubmit",
			event.target.elements["date"].value,
		);
	}

	export let variable: number;
</script>

<div class="number">
	<span>My number is {variable}!</span>
</div>
<Flatpickr
	{options}
	bind:value
	bind:formattedValue
	on:change={handleChange}
	name="date"
	bind:flatpickr
	on:close={() => {
		console.log("closed");
	}}
	dateFormat="Y-m-d"
/>
<button type="button" on:click={handleOpen}> Open picker </button>

<style>
	.number {
		color: red;
	}
</style>
