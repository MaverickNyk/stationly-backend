import { Request, Response } from 'express';
import { SduiService } from '../services/sduiService';

export class SduiController {
    /**
     * @swagger
     * /sdui/app/login:
     *   get:
     *     summary: Get Login Layout
     *     description: Retrieves the server-driven UI layout for the login screen.
     *     tags: [SDUI, Auth]
     *     responses:
     *       200:
     *         description: JSON Layout
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/Layout'
     */
    static getLoginLayout(req: Request, res: Response) {
        res.json(SduiService.getLoginLayout());
    }

    /**
     * @swagger
     * /sdui/app/register:
     *   get:
     *     summary: Get Register Layout
     *     description: Retrieves the server-driven UI layout for the registration screen.
     *     tags: [SDUI, Auth]
     *     responses:
     *       200:
     *         description: JSON Layout
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/Layout'
     */
    static getRegisterLayout(req: Request, res: Response) {
        res.json(SduiService.getRegisterLayout());
    }

    /**
     * @swagger
     * /sdui/app/forgot-password:
     *   get:
     *     summary: Get Forgot Password Layout
     *     description: Retrieves the server-driven UI layout for the forgot password screen.
     *     tags: [SDUI, Auth]
     *     responses:
     *       200:
     *         description: JSON Layout
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/Layout'
     */
    static getForgotPasswordLayout(req: Request, res: Response) {
        res.json(SduiService.getForgotPasswordLayout());
    }

    /**
     * @swagger
     * /sdui/app/layout:
     *   get:
     *     summary: Get Station Selection Layout
     *     description: Retrieves the server-driven UI layout for the station selection screen.
     *     tags: [SDUI]
     *     responses:
     *       200:
     *         description: JSON Layout
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/Layout'
     */
    static getSelectionLayout(req: Request, res: Response) {
        res.json(SduiService.getSelectionLayout());
    }
}
