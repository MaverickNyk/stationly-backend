import { Request, Response } from 'express';
import { SduiService } from '../services/sduiService';
import { TflService } from '../services/tflService';

export class SduiController {
    /**
     * Get Login Screen Blueprint
     */
    static getLoginLayout(req: Request, res: Response) {
        res.json(SduiService.getLoginLayout());
    }

    static getRegisterLayout(req: Request, res: Response) {
        res.json(SduiService.getRegisterLayout());
    }

    static getForgotPasswordLayout(req: Request, res: Response) {
        res.json(SduiService.getForgotPasswordLayout());
    }

    /**
     * Get Station Selection Blueprint
     */
    static getSelectionLayout(req: Request, res: Response) {
        res.json(SduiService.getSelectionLayout());
    }

    /**
     * Dynamically fetch dropdown data
     */
    static async getDropdownData(req: Request, res: Response) {
        const { type } = req.params;
        const { mode, line, direction } = req.query;

        try {
            switch (type) {
                case 'modes':
                    res.json(await TflService.getModes());
                    break;
                case 'lines':
                    res.json(await TflService.getLinesByMode(mode as string));
                    break;
                case 'directions':
                    res.json(await TflService.getDirectionsByLine(line as string));
                    break;
                case 'stations':
                    res.json(await TflService.getStationsByRoute(line as string, direction as string));
                    break;
                default:
                    res.status(404).json({ error: "Data source unknown" });
            }
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }
}
