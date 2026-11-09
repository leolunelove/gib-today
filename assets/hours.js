/* Opening status uses published venue hours in Gibraltar, regardless of the visitor's timezone. */
window.GibHours = (() => {
  const minutesPerDay = 1440;
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Gibraltar', calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23'
  });

  function localTime(now) {
    const {year, month, day, hour, minute} = Object.fromEntries(clock.formatToParts(now).map(part => [part.type, part.value]));
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    const weekday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - 1);
    return {date: `${year}-${month}-${day}`, yesterday: date.toISOString().slice(0, 10),
      weekday, minute: Number(hour) * 60 + Number(minute)};
  }

  function status(schedule, time, holidays) {
    if (!schedule) return null;
    const today = holidays.has(time.date) ? schedule.holiday : schedule.week[time.weekday];
    if (today == null) return null;
    if (today.some(([start, end]) => time.minute >= start && time.minute < end)) return 'open';
    // A holiday schedule takes precedence over regular service, including overnight carryover.
    if (!holidays.has(time.date)) {
      const yesterday = holidays.has(time.yesterday) ? schedule.holiday : schedule.week[(time.weekday + 6) % 7];
      if (yesterday?.some(([, end]) => time.minute + minutesPerDay < end)) return 'open';
    }
    return 'closed';
  }

  return {localTime, status};
})();
