ALTER TABLE quotes ADD COLUMN max_charge_currency text NOT NULL DEFAULT 'USD';
ALTER TABLE quotes ADD COLUMN max_charge_amount_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
