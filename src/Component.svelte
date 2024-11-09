<script lang="ts">
	import Flatpickr from "./Flatpickr.svelte";
	import { createEventDispatcher } from "svelte";

	import type EasyBake from "./main";

	import { picked_date } from "./date.store";

	let plugin: EasyBake;

	const dispatch = createEventDispatcher();

	export let value: undefined = undefined,
		formattedValue: any,
		flatpickr: Flatpickr;

	let mode = "single";

	let options;
	$: options = {
		mode,
		defaultDate:
			mode === "single" ? "2024-11-01" : ["2024-11-01", "2024-12-04"],
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

	function handleOpen(event: Event) {
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

	function handleSubmit(event: SubmitEvent) {
		console.log(
			"coming from the component itself on handleSubmit",
			(event.target as HTMLFormElement).elements["date"].value,
		);
	}
</script>

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
