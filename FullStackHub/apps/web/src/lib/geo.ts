// Coordinates for the cities used across the demo, so the tracking page can draw
// an origin -> destination route without a geocoding service.
export const CITY_COORDS: Record<string, [number, number]> = {
  "Panama City": [8.9824, -79.5199],
  Colón: [9.3592, -79.9014],
  Miami: [25.7617, -80.1918],
  "New York": [40.7128, -74.006],
  Houston: [29.7604, -95.3698],
  Bogotá: [4.711, -74.0721],
  "Mexico City": [19.4326, -99.1332],
  Lima: [-12.0464, -77.0428],
  Santiago: [-33.4489, -70.6693],
  "Buenos Aires": [-34.6037, -58.3816],
  Quito: [-0.1807, -78.4678],
};

export function cityCoords(city: string): [number, number] | undefined {
  return CITY_COORDS[city];
}
