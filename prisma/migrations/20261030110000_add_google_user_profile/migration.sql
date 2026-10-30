ALTER TABLE "User"
ADD COLUMN "googleId" TEXT,
ADD COLUMN "avatarUrl" TEXT;

CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
