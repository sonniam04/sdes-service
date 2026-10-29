-- ตารางประวัติ migration ของ Prisma เป็นของ owner เท่านั้น
-- (shadow database ของ prisma migrate dev ไม่มีตารางนี้ จึงตรวจก่อน)
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public._prisma_migrations FROM sdes_app';
  END IF;
END $$;
