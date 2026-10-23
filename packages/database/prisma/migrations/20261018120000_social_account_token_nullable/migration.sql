-- SocialAccount.tokenCiphertext is nullable in schema.prisma (YouTube accounts connected without
-- a refresh token store NULL) but the original migration created it NOT NULL.
ALTER TABLE "SocialAccount" ALTER COLUMN "tokenCiphertext" DROP NOT NULL;