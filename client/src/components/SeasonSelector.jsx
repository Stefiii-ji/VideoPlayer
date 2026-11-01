export default function SeasonSelector({ seasons, selected, onChange }) {
  return (
    <label className="season-select-label">
      <span>Season</span>
      <select value={selected} onChange={(event) => onChange(Number(event.target.value))}>
        {seasons.map((season) => <option value={season.number} key={season.number}>
          {season.number === 0 ? 'Specials' : `Season ${String(season.number).padStart(2, '0')}`}
        </option>)}
      </select>
    </label>
  );
}
