import { Module } from '@nestjs/common';
import { PrismaModule } from '@traeta/prisma';
import { TechvLogger } from 'techvedika-logger';
import { ListItemsController } from './list-items.controller';
import { ListItemsService } from './list-items.service';
import { UtilityService } from 'src/utility/utility.service';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from 'src/guards/guards';
@Module({
  imports: [PrismaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [ListItemsController],
  providers: [ListItemsService, TechvLogger, UtilityService, JwtAuthGuard],
})
export class ListItemsModule { }
