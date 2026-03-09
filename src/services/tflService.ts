import axios from 'axios';
import { formatModeLabel, getIconUrl, formatDestination } from '../utils/formatters';

export class TflService {
    private static baseUrl = 'https://api.stationly.co.uk/StationlyBE/api/v1';

    static async getModes() {
        try {
            const response = await axios.get(`${this.baseUrl}/modes`);
            return response.data.map((mode: any) => ({
                id: mode.modeName,
                label: formatModeLabel(mode.modeName),
                iconUrl: getIconUrl(mode.modeName)
            }));
        } catch (e) {
            return [{ id: "tube", label: "Underground", iconUrl: getIconUrl("tube") }];
        }
    }

    static async getLinesByMode(mode: string) {
        try {
            const response = await axios.get(`${this.baseUrl}/lines/mode/${mode}`);
            return response.data.map((line: any) => ({
                id: line.id,
                label: line.name
            }));
        } catch (e) {
            return [{ id: "piccadilly", label: "Piccadilly" }];
        }
    }

    static async getDirectionsByLine(line: string) {
        try {
            const response = await axios.get(`${this.baseUrl}/lines/${line}/route`);
            return response.data.directions.map((dir: any) => {
                const dirName = dir.direction.charAt(0).toUpperCase() + dir.direction.slice(1);
                let label = `${dirName} towards`;
                if (dir.destinations && dir.destinations.length > 0) {
                    const destNames = dir.destinations.map((d: any) => formatDestination(d.name)).join('\n');
                    label = `${dirName} towards\n${destNames}`;
                }
                return {
                    id: dir.direction,
                    label: label
                };
            });
        } catch (e) {
            return [{ id: "inbound", label: "Inbound" }, { id: "outbound", label: "Outbound" }];
        }
    }

    static async getStationsByRoute(line: string, direction: string) {
        try {
            const response = await axios.get(`${this.baseUrl}/stations/search?searchKey=${line}_${direction}`);
            return response.data.map((station: any) => ({
                id: station.naptanId,
                label: station.commonName
            }));
        } catch (e) {
            return [];
        }
    }
}
