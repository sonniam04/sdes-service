# service backup (design D7): pg_dump + คัดลอก bucket เอกสารจาก SeaweedFS ด้วย rclone, cron วันละครั้ง 02:00 เวลาไทย
FROM postgres:16.15-alpine3.23
RUN apk add --no-cache rclone tzdata
ENV TZ=Asia/Bangkok
COPY backup.sh restore-inside.sh /usr/local/bin/
RUN chmod 755 /usr/local/bin/backup.sh /usr/local/bin/restore-inside.sh \
 && echo "0 2 * * * /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
# งานของ crond ไม่ได้ environment ของ container — เก็บไว้ใน /run (mode 600) ให้ backup.sh โหลดเอง
# crond อยู่หน้า (log ไปที่ docker logs) · root เพื่อเขียน /backups ที่ bind mount จากเครื่อง
CMD ["sh", "-c", "umask 077 && export -p > /run/backup.env && exec crond -f -l 8"]
