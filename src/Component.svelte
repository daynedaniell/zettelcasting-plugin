<script lang="ts">
	import Flatpickr from "./Flatpickr.svelte";

	let value = undefined,
		formattedValue,
		flatpickr;

	let mode = "single";

	let options;
	$: options = {
		mode,
		defaultDate:
			mode === "single" ? "2021-01-01" : ["2022-03-01", "2022-03-04"],
		enableTime: true,
		onChange(selectedDates: any, dateStr: string) {
			console.log("flatpickr hook", selectedDates, dateStr);
		},
		onOpen() {
			console.log("opened");
		},
	};

	$: console.log({ value });

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
	}

	function handleClear() {
		if (flatpickr) {
			flatpickr.clear();
		}
	}

	function handleSubmit(event) {
		event.preventDefault();

		console.log(event.target.elements["date"].value);
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
