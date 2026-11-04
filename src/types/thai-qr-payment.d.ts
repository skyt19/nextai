declare module 'thai-qr-payment' {
  export interface PayloadForOptions {
    recipient: string;
    amount?: number | string;
    type?: 'msisdn' | 'natid' | 'ewallet' | 'bank';
    fromSatang?: boolean;
  }

  export function payloadFor(options: PayloadForOptions): string;
  export function renderThaiQRPayment(options: any): string;
  export function renderThaiQRPaymentMatrix(options: any): string;
  export class ThaiQRPaymentBuilder {
    promptpay(options: any): this;
    build(): string;
  }
}
